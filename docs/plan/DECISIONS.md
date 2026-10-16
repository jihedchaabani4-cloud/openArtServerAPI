# DECISIONS

| ID | Decision | Default |
|---|---|---|
| D-01 | Folder structure | One `folders` table with `parent_id`; a sub-folder is a normal folder |
| D-02 | Asset to folder relation | One folder per asset (`folder_id` column), no join table in v1 |
| D-03 | "All assets" | A view/query, never a row |
| D-04 | Generation outside a project (reference "My generations") | OPEN PRODUCT QUESTION. v1 requires a project. Schema does not block a nullable `project_id` later. The owner will test the reference app and decide |
| D-05 | Element import across projects | Copy (not reference) in v1 |
| D-06 | Folder delete | Blocked unless empty (409 `FOLDER_NOT_EMPTY`); assets are never deleted silently |
| D-07 | Folder listing default | Direct children only; `includeDescendants=true` is opt-in; "All assets" shows everything |
| D-08 | Cross-tenant response | 404, never 403 |
| D-09 | Credits arithmetic | Integer minor units preferred; no wallet redesign inside D3, only fix proven bugs |
| D-10 | Health endpoints | `/health` liveness (always 200), `/ready` readiness (503 if Redis not ready) |
| D-11 | Internal-secret auth | Off unless `INTERNAL_AUTH_ENABLED=true`; exact method+path pairs of real callers only |
| D-12 | Folder limits | Config `FOLDER_MAX_DEPTH`=5, `FOLDER_MAX_PER_PROJECT`=500, `ASSET_LIST_MAX_LIMIT`=200 |
| D-13 | Unknown audit scopes (GEN1, NAM0, DM1) | Skip with an escalation note; never guess |
| D-14 | Spec Kit unavailable | Continue using this file's task cards as the spec |
| D-15 | Folder names | Unique among siblings (case-insensitive); same name allowed under different parents |
| D-16 | Moving an asset | Dedicated route `PATCH /api/assets/:assetId/folder`; the generic update route must not accept `folderId`, `projectId`, `userId` |
| D-17 | Migration of asset `user_id` | Add nullable, backfill in a separate step, enforce NOT NULL in a later migration (not in this plan) |
| D-18 | Folder FK delete rule | `NO ACTION` (default), not `RESTRICT`, so project cascade deletes work |
| D-19 | Concurrent folder moves | Accept the rare race in v1; BACKLOG item to add a transaction with row locks |
| D-20 | Legacy listing endpoints | Keep their response shapes unchanged; new filtered/paginated listing is separate or backward compatible |
| D-21 | Naming of existing things | NO renames of tables, columns, classes, files, routes or env vars. `workflow` stays `workflow` even though it is the "Asset" in product terms. Rename later as a separate project (BACKLOG `RENAME-LATER`) |
| D-22 | Asset-level code | Extend the EXISTING repository/service of the asset-level table. No new `AssetRepository`, `AssetService`, `assets` table or view |
| D-23 | Public API vocabulary | New public endpoints and JSON use product words (`assets`, `folders`, `folderId`). One serializer maps the real row to the asset JSON. Existing routes unchanged |
| D-24 | Hierarchy storage | Only direct relations (`parent_id`, `folder_id`). No `level`, `depth`, `path`, `root_id`, `ancestor_ids` columns |
| D-25 | Same-project rule | Enforced twice: composite foreign keys in the DB AND checks in the service. Depth check on move includes the height of the moved sub-tree |
| D-26 | Media parameter string-vs-array normalization | Keep `schemaValidator.js` tolerance for strings to avoid breaking existing clients; normalize at the boundary via shared helper `toMediaIdList(value)` (`string -> [string]`, `array -> array`, `{ workflow_id, id } -> [id]`, else `[]`) in both controller ownership checks and V2 node media resolution |

D-14 | 2026-10-07 | Question: Spec Kit usage | Options: SPEC_KIT=ON, SPEC_KIT=OFF | Chosen: SPEC_KIT=OFF | Reason: Prompt explicitly set SPEC_KIT=OFF; Spec Kit is already installed, using the task cards of the phase files as spec
D-26 | 2026-10-16 | Question: How to close ownership gap when clients send string/object instead of array for media parameters | Options: Strict 400 in schemaValidator vs boundary normalization via `toMediaIdList` | Chosen: Boundary normalization via `toMediaIdList` | Reason: Preserves backward compatibility for non-frontend API clients that pass single media IDs as strings while ensuring every media parameter shape undergoes `assertOwnsAny` before workflow/media/billing creation and resolves identically in V2 nodes

