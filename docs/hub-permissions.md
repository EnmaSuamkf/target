# Hub owner permissions

This is the local counterpart of `target-server/docs/rbac.md`. The server
already decides which `remote.*` IDs a linked owner has. The hub caches that
role and applies it to its own HTTP API and UI. The catalogue is the same
`remote.*` list; the hub does not invent local permission IDs.

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
| D4 | Reuse the server's `remote.*` catalogue. | One vocabulary on both sides. The hub does not mint `hub.*` IDs. |
| D5 | While linked, `DELETE /api/device-link` and `PUT /api/settings/sync` require `remote.workflows.manage`. | Unlinking or flipping Remote Sync is a governance action, not a local preference. |
| D6 | `POST /api/workflows/:id/pause` accepts `remote.workflows.execute` **or** `remote.workflows.manage`. | Stopping dispatch is both a run control and a manage action. Either role can hold the line. |

## `GET /api/permissions`

Protected by the operator gate (`isAdmin`: session cookie or admin bearer)
and **not** by `requirePermission` — this is how the UI learns the role.

```json
{
  "mode": "unrestricted" | "enforced" | "read_only",
  "linkState": "local_unconfigured" | "awaiting_authorization" | "connected" | "…",
  "ownerId": "owner_…" | null,
  "permissions": ["remote.read", "remote.workflows.execute"],
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
| `DELETE` | `/api/device-link` | `remote.workflows.manage` (D5) |
| `PUT` | `/api/settings/sync` | `remote.workflows.manage` (D5) |

Other `/api/settings/*` writes stay operator-gated only (`isAdmin`). Linking
(`POST /api/device-link/start`, `POST /api/device-link/poll`) is operator-gated
and not role-gated: there is no owner yet.

### Workflows

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/workflows` | `remote.workflows.create` |
| `DELETE` | `/api/workflows/:id` | `remote.workflows.manage` |
| `POST` | `/api/workflows/:id/clone` | `remote.workflows.create` |
| `PATCH`/`PUT` | `/api/workflows/:id/name` | `remote.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/docker-mounts` | `remote.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/tcps` | `remote.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/resourcesets` | `remote.workflows.manage` |
| `PATCH`/`PUT` | `/api/workflows/:id/context` | `remote.workflows.manage` |
| `POST` | `/api/workflows/:id/attachments` | `remote.workflows.manage` when `field` is `context`; otherwise `remote.workflows.steps.edit` |
| `DELETE` | `/api/attachments/:id` | same rule as the attachment's field |
| `POST` | `/api/workflows/:id/open-terminal` | `remote.workflows.execute` |
| `POST` | `/api/conversations/open-terminal` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/steps` | `remote.workflows.steps.add` |
| `POST` | `/api/workflows/:id/steps/from-template` | `remote.workflows.steps.add` |
| `PATCH` | `/api/workflows/:id/steps/:stepId` | `remote.workflows.steps.edit` |
| `DELETE` | `/api/workflows/:id/steps/:stepId` | `remote.workflows.manage` |
| `POST` | `/api/workflows/:id/steps/:stepId/notes` | `remote.workflows.steps.edit` |
| `PATCH` | `/api/workflows/:id/steps/:stepId/notes/:noteId` | `remote.workflows.steps.edit` |
| `DELETE` | `/api/workflows/:id/steps/:stepId/notes/:noteId` | `remote.workflows.steps.edit` |
| `POST` | `/api/workflows/:id/steps/:stepId/run` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/continue` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/abort` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/open-terminal` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/steps/:stepId/status` | `remote.workflows.manage` |
| `POST` | `/api/workflows/:id/steps/:stepId/move` | `remote.workflows.manage` |
| `POST` | `/api/workflows/:id/status` | `remote.workflows.manage` |
| `PUT`/`PATCH` | `/api/workflows/:id/selection` | `remote.workflows.manage` |
| `POST` | `/api/workflows/:id/start` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/resume` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/restart` | `remote.workflows.execute` |
| `POST` | `/api/workflows/:id/pause` | `remote.workflows.execute` **or** `remote.workflows.manage` (D6) |
| `POST` | `/api/tcps/execute` | `remote.workflows.execute` (skipped when the caller is a running step with its callback token) |

### Templates

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/templates` | `remote.templates.create` |
| `PATCH`/`PUT` | `/api/templates/:id` | `remote.templates.edit` |
| `DELETE` | `/api/templates/:id` | `remote.templates.delete` |
| `POST` | `/api/templates/import` | `remote.templates.import` |
| `GET` | `/api/templates/export` | `remote.templates.export` |
| `GET` | `/api/templates/:id/export` | `remote.templates.export` |

### TCP tools

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/tcps` | `remote.tcp-tools.create` |
| `PATCH`/`PUT` | `/api/tcps/:id` | `remote.tcp-tools.edit` |
| `DELETE` | `/api/tcps/:id` | `remote.tcp-tools.delete` |
| `POST` | `/api/tcps/import` | `remote.tcp-tools.import` |
| `GET` | `/api/tcps/export` | `remote.tcp-tools.export` |
| `GET` | `/api/tcps/:id/export` | `remote.tcp-tools.export` |

### RCI

There is no RCI bundle export. Scan is a create: it reads a folder and
returns resources without storing them; saving the set is a later
`create` or `edit`.

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/resourcesets` | `remote.rci.create` |
| `POST` | `/api/resourcesets/scan` | `remote.rci.create` |
| `PATCH`/`PUT` | `/api/resourcesets/:id` | `remote.rci.edit` |
| `DELETE` | `/api/resourcesets/:id` | `remote.rci.delete` |

The catalogue also lists `remote.rci.import` and `remote.rci.export`. The hub
has no routes for those IDs today.

## UI

The UI polls `GET /api/permissions` on the existing 2s tick. Controls are
**disabled**, not hidden, with a `title` that names the missing id
(`Requiere remote.workflows.execute`). Settings → **Permisos de tu rol**
shows the mode, the server origin, the `granted` list the server already
trimmed, and the read-only warning. Disconnect and the Remote Sync switch
require `remote.workflows.manage` (D5).

## This is not a security boundary

This is gobernanza de UI y de la API local, **no una frontera de seguridad**.

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
