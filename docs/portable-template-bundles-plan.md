# Portable template bundles — implementation plan

Status: implemented.
Repository: `/home/lenovo/Documentos/target` (default branch `main`).
Scope of this change: **pipelines only**. TCPs and resource sets have a similar
id-reference problem and are explicitly out of scope (follow-up PR).

## 1. Problem

A template step of kind `command` stores only `pipelineId`, a UUID that exists
on the machine that created it. Template bundles are therefore not portable:

| Where | What happens today |
|---|---|
| `hub/db.ts` → `templateBundle()` (~line 3247) | Exports `steps` verbatim, so a command step carries the local `pipelineId` and nothing else. The pipeline itself is not in the bundle. |
| `hub/pipeline-store.ts` → `importPipelines()` (~line 421) | Always inserts NEW pipelines with fresh UUIDs (`insertPipeline`, `crypto.randomUUID()`), so importing the pipeline separately never reproduces the id the template points to. Importing the same pipeline twice also creates duplicates. |
| `hub/workflow.ts` → `checkCommandStep()` (~line 2006) | Seeding a workflow from such a template fails with `unknown pipeline "<uuid>"`. |
| `hub/catalog-sync.ts` → `upsertTemplates()` (~line 300) | Server-synced templates silently DROP command steps whose pipeline id is unknown locally. (Not changed by this plan; catalog sync keeps ids because the server owns them.) |

Pipeline names cannot be used as the key: the name lives inside the YAML
source and is NOT unique (`importPipelines` deliberately does not rename).

## 2. Design

### 2.1 Key idea: reference pipelines by content, ship them inside the bundle

Every pipeline already has `source_hash` (sha256 of its YAML text, column
`pipelines.source_hash`, computed by `sourceHash()` in `hub/pipeline-yaml.ts`).
Two pipelines with the same hash are, byte for byte, the same pipeline. The
template bundle embeds the YAML of every pipeline its command steps use, and
the import resolves each one to a local pipeline by hash.

### 2.2 Bundle format v2

Bump `TEMPLATE_BUNDLE_SCHEMA_VERSION` from `1` to `2` in `hub/db.ts`.

```json
{
  "kind": "target.templates",
  "schemaVersion": 2,
  "exportedAt": "2026-11-13T12:00:00.000Z",
  "templates": [
    {
      "name": "checkout and install",
      "tags": [],
      "steps": [
        {
          "description": "Check out main",
          "kind": "command",
          "pipelineRef": "p1",
          "pipelineInputs": { "dir": ".", "branch": "main" },
          "onSuccessTask": null,
          "onFailureTask": "…",
          "acceptanceCriteria": null,
          "manualReview": false,
          "useSubagent": false,
          "maxRetries": 3,
          "retryIntervalSeconds": 0
        }
      ],
      "tcpIds": [],
      "tcpSelections": [],
      "resourceSelections": []
    }
  ],
  "pipelines": [
    {
      "ref": "p1",
      "name": "git-checkout-base",
      "tags": ["git"],
      "source": "name: git-checkout-base\n…",
      "sourceHash": "521e5386…"
    }
  ]
}
```

Rules:

- `pipelines[]` is a top-level array, de-duplicated: a pipeline used by several
  steps/templates in the bundle appears ONCE.
- `ref` is a bundle-local identifier (`"p1"`, `"p2"`, … in order of first
  use). It is NOT a hub id.
- A v2 command step carries `pipelineRef` and **no** `pipelineId` (the local
  UUID is meaningless elsewhere and must not leak into the file).
- `sourceHash` is informational; on import the hub RECOMPUTES the hash from
  `source` and never trusts the value in the file. If they differ, use the
  recomputed one (do not fail the import).
- No trust state, no secret values, no hub ids in the bundle — same rule as
  the existing pipeline bundle (`pipelineBundle()` in `hub/pipeline-store.ts`).
- A command step whose pipeline no longer exists locally at export time is
  exported with neither `pipelineRef` nor `pipelineId` and the export still
  succeeds (the import will report it as unresolved).

### 2.3 Import resolution

For each entry in `pipelines[]`:

1. Validate the YAML with `parsePipeline()`. If ANY entry is invalid, refuse
   the whole import with 400 (same behaviour as `parsePipelineBundle`). Nothing
   is created.
2. Compute `hash = sourceHash(source)`.
3. If a local, non-revoked pipeline with `source_hash === hash` exists →
   **reuse it** (prefer one that is trusted; then the oldest). Its trust is
   kept. Record `{ ref, action: "reused", pipelineId, name, trusted }`.
4. Otherwise → create it with `insertPipeline({ source, tags, approve: false })`
   (UNTRUSTED, operator must approve it in the UI before it runs). Record
   `{ ref, action: "created", pipelineId, name, trusted: false }`.
   If a local pipeline with the same NAME but a different hash exists, also add
   a warning `{ code: "pipeline_name_conflict", ref, name }` — the bundle's
   version is still created as a separate pipeline (the template must run the
   exact text that was exported; never silently bind to a different text).
5. Within one import, the same hash is resolved once (map hash → local id), so
   two entries with identical source do not create two rows.

Then for each template step of kind `command`:

- `pipelineRef` present and found in the map → set `pipelineId` to the local id
  and drop `pipelineRef` before storing.
- `pipelineRef` present but not in `pipelines[]` → keep the step with
  `pipelineId: null`, warning `{ code: "unresolved_pipeline", template, stepIndex, reason: "missing_ref" }`.

### 2.4 Backward compatibility (v1 bundles, bare arrays, bare templates)

v1 command steps only carry `pipelineId`. Resolve in this order:

1. `pipelineId` exists locally → keep it (same-machine round trip).
2. Else → keep the step with `pipelineId: null` and warn
   `{ code: "unresolved_pipeline", template, stepIndex, reason: "unknown_id" }`.

Do NOT guess by name for v1 (v1 steps do not carry a name; and names are not
unique). The template is still imported — an import never fails because of an
unresolved pipeline; it reports it.

`parseTemplateBundle()` must keep accepting v1 and v2; only `schemaVersion > 2`
is refused with `unsupported_schema_version` (existing rule).

### 2.5 Pipeline bundle dedupe (same rule, standalone pipeline import)

`importPipelines()` in `hub/pipeline-store.ts` must apply step 2.3 (3)–(5):
an entry whose hash already exists locally is reused instead of duplicated.
Its return value must make the difference visible, e.g. return
`{ pipeline, action: "reused" | "created" }[]`, and
`POST /api/pipelines/import` answers `{ pipelines: [...], results: [...] }`
(keep the existing `pipelines` field for compatibility; add `results`).
Check `hub/pipelines-routes.test.ts` and the UI caller
(`hub/ui/src/api/client.ts`, `PipelinesView.tsx`) and keep them working.

## 3. Where the code goes

`hub/pipeline-store.ts` imports from `hub/db.ts`, so **`db.ts` must not import
`pipeline-store.ts`** (circular import). Put the orchestration in a NEW module:

- **`hub/template-bundle.ts`** (new): imports from both `db.ts` and
  `pipeline-store.ts`. Exports:
  - `buildTemplateBundle(templates: Template[]): TemplateBundle` — v2 export
    with embedded pipelines (uses `getPipeline()` for each `pipelineId`).
  - `importTemplateBundle(input: unknown): TemplateImportResult` — parses
    (delegating per-template normalisation to `parseTemplateBundle`), resolves
    pipelines (section 2.3/2.4), inserts templates via the existing
    `importTemplates()` naming rules, and returns
    `{ templates: Template[], pipelines: PipelineImportResult[], warnings: TemplateImportWarning[] }`.
  - Make the whole import atomic: pipelines + templates in ONE SQLite
    transaction (look at how `db.ts` uses `database.exec("BEGIN")`/transactions
    elsewhere and follow the same pattern). If anything throws, nothing is left
    behind.
- **`hub/db.ts`**:
  - `TEMPLATE_BUNDLE_SCHEMA_VERSION = 2`.
  - `TemplateBundle` gains optional `pipelines?: TemplateBundlePipeline[]`.
  - `TemplateStep` handling in `normalizeTemplateSteps` (~line 2886): keep
    `pipelineId` for stored templates; the bundle-only `pipelineRef` is handled
    in `template-bundle.ts` BEFORE normalisation or by a small, explicit
    extension — but a stored template must never persist `pipelineRef`.
  - `templateBundle()` stays (or becomes a thin wrapper) so other callers keep
    compiling; the server routes switch to `buildTemplateBundle`.
- **`hub/pipeline-store.ts`**: add `findPipelineByHash(hash)` and the dedupe in
  `importPipelines()` (section 2.5).
- **`hub/server.ts`** (~line 1843–1900):
  - `GET /api/templates/export` and `GET /api/templates/:id/export` →
    `buildTemplateBundle(...)`.
  - `POST /api/templates/import` → `importTemplateBundle(body)`; answer
    `{ templates, pipelines, warnings }` (templates in `publicTemplate` shape as
    today). Keep 400 + `{ error: code }` for invalid bundles, and add
    `invalid_pipeline` with `{ errors }` when an embedded YAML is invalid.
  - Log line: also list created/reused pipelines.
- **`hub/ui/src/api/client.ts`** + **`hub/ui/src/api/types.ts`**:
  `importTemplates()` returns the full result (templates, pipelines, warnings).
- **`hub/ui/src/App.tsx`** (`handleImportTemplates`, ~line 1287): the success
  toast must also say how many pipelines were created and that they need
  approval (e.g. `Imported "X". 1 pipeline created — approve it in Pipelines
  before running.`), and show warnings (unresolved pipeline, name conflict) as
  a warning toast. Keep messages short and in English.
- **`mcp/target-mcp.mjs`** (`import_templates`, `export_templates`,
  `export_all_templates`, ~line 1055): update descriptions to say bundles
  embed the pipelines they use, and that imported pipelines arrive unapproved.
- **`docs/pipelines.md`** section "### Templates" (~line 431): document the v2
  bundle, the hash-based resolution, the untrusted-on-create rule, and the
  warnings.

## 4. Security rules (must hold)

- An import NEVER creates a trusted pipeline. Reused pipelines keep the trust
  they already had locally (same text ⇒ same approval is valid, because trust is
  bound to `trusted_hash === source_hash`).
- Hashes in the file are never trusted; always recompute.
- No secret values in bundles (pipelines reference secrets by name only;
  confirm nothing from `pipeline-secrets.ts` is exported).
- Import stays admin-gated (`client.templates.import`), export stays
  `client.templates.export` — unchanged.
- Bundle size limit stays `catalogMaxBytes` (see `hub/import-size.test.ts`).

## 5. Tests (node:test, `hub/*.test.ts`, run with `npm test` from the repo root)

Add `hub/template-bundle.test.ts` (and extend `hub/server.test.ts` /
`hub/pipeline-store.test.ts` / `hub/pipelines-routes.test.ts` where natural):

1. Export of a template with a command step → `schemaVersion: 2`, step has
   `pipelineRef` and NO `pipelineId`, `pipelines[]` holds the YAML and hash.
2. Two templates/steps using the same pipeline → `pipelines[]` has it once.
3. Round trip on a fresh hub (empty pipelines) → pipeline created UNTRUSTED,
   template step points to the new id, result says `created`.
4. Import when an identical pipeline (same hash) exists and is trusted → no new
   pipeline row, step points to the existing id, trust kept, result `reused`.
5. Same name, different source locally → new pipeline created, warning
   `pipeline_name_conflict`.
6. Importing the same bundle twice → second time reuses (no duplicate
   pipelines), templates get the usual `Clone - ` names.
7. Tampered `sourceHash` in the file → ignored, recomputed hash used.
8. Invalid YAML in `pipelines[]` → 400 `invalid_pipeline`, NOTHING created
   (no pipelines, no templates).
9. `pipelineRef` not present in `pipelines[]` → template imported, step
   `pipelineId: null`, warning `unresolved_pipeline` / `missing_ref`.
10. v1 bundle whose `pipelineId` exists locally → kept; unknown id → null +
    warning `unknown_id`.
11. `schemaVersion: 3` → 400 `unsupported_schema_version`.
12. Standalone `POST /api/pipelines/import` of an already-present pipeline →
    reused, not duplicated.
13. Existing tests in `hub/templates.test.ts`, `hub/server.test.ts`,
    `hub/import-size.test.ts`, `hub/pipeline-store.test.ts`,
    `hub/pipelines-routes.test.ts`, `hub/catalog-sync*.test.ts` keep passing
    (update expectations of `schemaVersion` from 1 to 2 where they assert it).

## 6. Definition of done

- `npm run typecheck` (root: hub + hub/ui) passes.
- `npm test` (root: hub tests + mcp tests) passes.
- Exporting a template that uses a pipeline and importing it on a hub that has
  never seen that pipeline yields a usable template whose command step points
  to a newly created, unapproved pipeline; after approval the step runs.
- Importing on a hub that already has the same pipeline creates nothing new.
- Docs updated (`docs/pipelines.md`) and this plan file is kept in the PR.

## 7. Out of scope

- TCP (`tcpSelections`) and resource-set (`resourceSelections`) portability.
- Catalog sync from target-server (`hub/catalog-sync.ts`) — ids there are
  owned by the server and stay as they are.
- Showing "referenced by" in the template editor.

## 8. Operational notes for the implementing agent

- A live Target hub runs from this same repository on port 8893. Do NOT stop,
  restart or `pkill` it (never `pkill -f "node daemon.ts"`). Tests start their
  own throwaway hubs; that is enough.
- Do not run shell commands to build/test/commit: the workflow runs install,
  typecheck, tests and the PR through hub pipelines. Agent steps only read and
  edit files.
- Keep the code style of the surrounding files (tabs, long explanatory
  comments on non-obvious decisions, `node:test` + `node:assert/strict`).
