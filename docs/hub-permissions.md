# Hub owner permissions

This is the local counterpart of `target-server/docs/rbac.md`. The server
already decides which `client.*` IDs a linked owner has. The hub caches that
role and applies it to its own HTTP API and UI. The catalogue is the same
`client.*` list; the hub does not invent local permission IDs.

## Modes

`resolvePermissionMode()` in `hub/owner-permissions.ts` answers one of three
modes:

| Mode | When | Effect |
| --- | --- | --- |
| `unrestricted` | Device link is `local_unconfigured` | Every permission is granted. An unlinked hub is a local machine. |
| `enforced` | Linked, with a live owner snapshot younger than the grace window | Only the IDs in the snapshot are granted. |
| `read_only` | Linked without an owner, snapshot stale, `relink_required`, or `awaiting_authorization` | Every mutation is refused. |

Grace is `max(30s, 3 × syncIntervalMs)` (D2). Disk loads after a process
restart start stale until the next live register/heartbeat. Work that is
already running is not aborted when the role is lost or goes stale.

`GET` reads (except exports) stay open in every mode (D1). `/api/auth/*` and
the step callbacks (`POST /api/steps/:id/started`, `POST /api/steps/:id/result`)
are not role-gated.

## Operator decisions

| Id | Decision | Why |
| --- | --- | --- |
| D1 | GET reads are never blocked, except export bundles. | A greyed button that still lets you inspect local data is honest; hiding the list looks like a crash. Exports are a write of the catalogue onto another machine, so they take `.export`. |
| D2 | After `max(30s, 3 × syncIntervalMs)` without a live heartbeat the hub goes `read_only`. Running work finishes. | Same TTL the server already uses for presence. Killing an in-flight step because the owner packet is late would be worse than waiting. |
| D3 | Unlinked = `unrestricted`. Linked with `owner: null` = `read_only`. | No server, no role. A link that never received an owner is not a licence to mutate. |
| D4 | Use the server's `client.*` catalogue (same IDs that used to be `remote.*`). | One vocabulary on both sides. The hub does not mint `hub.*` IDs. |
| D5 | While linked, `DELETE /api/device-link` and `PUT /api/settings/sync` require `client.workflows.manage`. | Unlinking or flipping Remote Sync is a governance action, not a local preference. |
| D6 | `POST /api/workflows/:id/pause` accepts `client.workflows.execute` **or** `client.workflows.manage`. | Stopping dispatch is both a run control and a manage action. Either role can hold the line. |

## `GET /api/permissions`

Protected by the operator gate (`isAdmin`: session cookie or admin bearer)
and **not** by `requirePermission` — this is how the UI learns the role.

```json
{
  "mode": "unrestricted" | "enforced" | "read_only",
  "linkState": "local_unconfigured" | "awaiting_authorization" | "connected" | "…",
  "ownerId": "owner_…" | null,
  "permissions": ["client.read", "client.workflows.execute"],
  "granted": { "groups": [{ "id": "…", "scope": "…", "label": "…", "description": "…", "permissions": [{ "id": "…", "label": "…", "description": "…" }] }] },
  "receivedAt": "2026-09-23T08:00:00.000Z" | null,
  "staleAfter": "2026-09-23T08:00:30.000Z" | null
}
```

When the mode is `unrestricted` or `read_only`, `permissions` is `[]` and
`ownerId` may be `null`. `granted` is never omitted (`{ "groups": [] }` if
the server sent nothing). The body never includes a device secret or private
key — the same rule as `GET /api/device-link`.

A 403 from a gated route is `{ "error": "forbidden", "permission": "<first id>", "mode": "enforced"|"read_only" }`.

## Route → permission

`requirePermission` replaces the old per-route `isAdmin` check on mutating
paths and on export GETs. Unrestricted hubs still pass. The first id in the
list is the one a 403 names.

### Device link and settings

| Method | Path | Permission |
| --- | --- | --- |
| `DELETE` | `/api/device-link` | `client.workflows.manage` (D5) |
| `PUT` | `/api/settings/sync` | `client.workflows.manage` (D5) |

Other `/api/settings/*` writes stay operator-gated only (`isAdmin`). Linking
(`POST /api/device-link/start`, `POST /api/device-link/poll`) is operator-gated
and not role-gated: there is no owner yet.

### Catalog sync

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/catalog/sync` | any of `client.templates.sync`, `client.tcp-tools.sync`, `client.rci.sync` (and `enforced`; `409 not_linked` otherwise) |
| `GET` | `/api/catalog/sync/status` | operator gate only |

`POST` calls the linked server's `GET /api/sync/catalog`. An old server that
404s that path becomes `502 { "error": "catalog_sync_unsupported" }`. The hub
upserts TCP/RCI then templates in one SQLite transaction, then prunes copies
that lost the `catalog` source.

### Synced copies (`origin` / `sync_source` / `revoked`)

Templates, TCP packs and resource sets store:

- `origin`: `local` or `server`
- `sync_source`: `workflow`, `catalog`, or `workflow,catalog` (a row can arrive
  both from a remote workflow attach and from a catalog pull)
- `revoked`: `1` when the catalog drop could not delete the row because a
  workflow still references it

Local PATCH/DELETE of an `origin=server` row returns `409 { "error":
"server_managed" }` (templates included — the same rule TCP/RCI already had).
GET export bundles omit `origin=server` rows. Sync command handlers write the
store directly and skip the HTTP usage gate.

List and detail include `usable: boolean` (local rows are always `true`) so
the MCP sees the same flag as the UI.

### Enabled / Disabled (`canUseServerResources`)

A server copy is **usable** only when `canUseServerResources()` is true and
`revoked` is not set. `canUseServerResources()` is true only in `enforced`
mode when the owner has any of `client.workflows.create`,
`client.workflows.steps.add`, `client.workflows.steps.edit`, or
`client.workflows.manage`. Unrestricted and `read_only` hubs mark every
server copy Disabled.

Operator HTTP returns `403 { "error": "server_resource_disabled", "resourceId" }`
when creating a workflow from a server template, appending a server template,
**adding** a server TCP/RCI to a workflow or a local template, or referencing
them from `POST`/`PATCH` `/api/templates`. Removing an already-attached server
TCP/RCI stays allowed.

### Workflows

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/workflows` | `client.workflows.create` |
| `DELETE` | `/api/workflows/:id` | `client.workflows.manage` |
| `POST` | `/api/workflows/:id/clone` | `client.workflows.create` |
| `PATCH`/`PUT` | `/api/workflows/:id/name` | `client.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/docker-mounts` | `client.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/tcps` | `client.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/resourcesets` | `client.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/context` | `client.workflows.manage` |
| `POST` | `/api/workflows/:id/attachments` | `client.workflows.manage` when `field` is `context`; otherwise `client.workflows.steps.edit` |
| `DELETE` | `/api/attachments/:id` | same rule as the attachment's field |
| `POST` | `/api/workflows/:id/open-terminal` | `client.workflows.execute` |
| `POST` | `/api/conversations/open-terminal` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/steps` | `client.workflows.steps.add` |
| `POST` | `/api/workflows/:id/steps/from-template` | `client.workflows.steps.add` |
| `PATCH` | `/api/workflows/:id/steps/:stepId` | `client.workflows.steps.edit` |
| `DELETE` | `/api/workflows/:id/steps/:stepId` | `client.workflows.manage` |
| `POST` | `/api/workflows/:id/steps/:stepId/notes` | `client.workflows.steps.edit` |
| `PATCH` | `/api/workflows/:id/steps/:stepId/notes/:noteId` | `client.workflows.steps.edit` |
| `DELETE` | `/api/workflows/:id/steps/:stepId/notes/:noteId` | `client.workflows.steps.edit` |
| `POST` | `/api/workflows/:id/steps/:stepId/run` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/continue` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/abort` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/open-terminal` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/status` | `client.workflows.manage` |
| `POST` | `/api/workflows/:id/steps/:stepId/move` | `client.workflows.manage` |
| `POST` | `/api/workflows/:id/status` | `client.workflows.manage` |
| `PUT`/`PATCH` | `/api/workflows/:id/selection` | `client.workflows.manage` |
| `POST` | `/api/workflows/:id/start` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/resume` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/restart` | `client.workflows.execute` |
| `POST` | `/api/workflows/:id/pause` | `client.workflows.execute` **or** `client.workflows.manage` (D6) |
| `POST` | `/api/tcps/execute` | `client.workflows.execute` (skipped when the caller is a running step with its callback token) |

### Templates

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/templates` | `client.templates.create` |
| `PATCH`/`PUT` | `/api/templates/:id` | `client.templates.edit` |
| `DELETE` | `/api/templates/:id` | `client.templates.delete` |
| `POST` | `/api/templates/import` | `client.templates.import` |
| `GET` | `/api/templates/export` | `client.templates.export` |
| `GET` | `/api/templates/:id/export` | `client.templates.export` |

### TCP tools

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/tcps` | `client.tcp-tools.create` |
| `PATCH`/`PUT` | `/api/tcps/:id` | `client.tcp-tools.edit` |
| `DELETE` | `/api/tcps/:id` | `client.tcp-tools.delete` |
| `POST` | `/api/tcps/import` | `client.tcp-tools.import` |
| `GET` | `/api/tcps/export` | `client.tcp-tools.export` |
| `GET` | `/api/tcps/:id/export` | `client.tcp-tools.export` |

### RCI

There is no RCI bundle export. Scan is a create: it reads a folder and
returns resources without storing them; saving the set is a later
`create` or `edit`.

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/resourcesets` | `client.rci.create` |
| `POST` | `/api/resourcesets/scan` | `client.rci.create` |
| `PATCH`/`PUT` | `/api/resourcesets/:id` | `client.rci.edit` |
| `DELETE` | `/api/resourcesets/:id` | `client.rci.delete` |

The catalogue also lists `client.rci.import` and `client.rci.export`. The hub
has no routes for those IDs today.

## UI

The UI polls `GET /api/permissions` on the existing 2s tick. Controls are
**disabled**, not hidden, with a `title` that names the missing id
(`Requires client.workflows.execute`). Settings → **Your role permissions**
shows the mode, the server origin, the `granted` list the server already
trimmed, and the read-only warning. Disconnect and the Remote Sync switch
require `client.workflows.manage` (D5). Settings → **Catalog navigation**
shows a **Sync resources** button when the mode is `enforced` and the owner
has any `client.*.sync` permission; it polls `GET /api/catalog/sync/status`
on the same 2s tick and toasts the per-domain added/updated/removed/revoked
counts (or “The server does not support resource sync”). Template, TCP and
RCI lists filter All / Own / Synced and show a Synced badge plus an
Enabled/Disabled pill. Unusable server templates appear as disabled options
suffixed “ — Disabled”; unusable TCP/RCI checkboxes stay off unless they are
already selected (so they can still be removed).

## This is not a security boundary

This is UI governance of the local API, **not a security boundary**.

Anyone with a shell on this machine can skip it:

- the **adminToken** printed when the daemon starts (and stored in
  `~/.target/config.json`) authorizes every `/api` route as the operator;
- `hub/cli.ts` talks **directly to the SQLite database**, not through
  `requirePermission`;
- editing `~/.target/target.db` (or `$TARGET_HOME/target.db`) writes the same
  rows the API would have refused;
- deleting `device-link.json` returns the hub to `unrestricted`.

The real boundary remains target-server: it is the one that issues the owner
payload and can revoke the device. The hub only mirrors that decision for
operators who stay inside the UI and the HTTP API.
