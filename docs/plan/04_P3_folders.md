# Phase P3: Folders feature (project, folders, assets)

> Read `00_CORE.md` completely BEFORE this file (rules, loop, rubric, decisions). Section numbers are those of the original plan; the index in `00_CORE.md` says where each section lives.
> Scope of THIS file: section 7 (7.1 to 7.10, tasks F-T1 to F-T9). Do not read or start other phase files.
> Prerequisites: Phase P2 is DONE: `docs/plan/reports/SES0.md` exists with a Path A or Path B verdict and `docs/plan/NAMING_MAP.md` exists. If not, STOP and say so.
>
> NAMING WARNING: in this phase the word "asset" is a PRODUCT word. In the database the asset is the EXISTING table that `NAMING_MAP.md` lists (probably `workflow`). You only ADD a `folder_id` column (and constraints) to that existing table. You NEVER create a table, view, alias or repository named `asset` or `assets`. Only the NEW public API endpoints say `assets` (decisions D-21, D-22, D-23).


## Order of work in this session

1. If `SPEC_KIT = ON`: PREP-P3 first (`05_SPEC_KIT_GUIDE.md`), using sections 7.1 to 7.7 of THIS file as the spec, STOP, wait for `GO`. If OFF: start directly with F-T1.
2. Tasks F-T1 to F-T9 in order (section 7.8), one commit each.
3. Phase gate, acceptance test, write `docs/plan/reports/P3-SUMMARY.md`, STOP.

---

## 7. Phase P3: Folders feature (project, folders, assets)

Read this whole section once before starting F-T1. It is long on purpose.

### 7.1 Goal and target model (what we are building, in plain words)

We copy the organization idea of a reference product (Higgsfield-style Cinema Studio). That product has 3 navigation levels: Global library (Home, My generations, My elements, My favorites, Projects) -> Project -> Folder. THIS phase builds only the PROJECT and FOLDER levels. The Global library is out of scope (7.10), but we must not block it.

Inside one project the user sees these sections: Project brief, Settings, Elements, Tools, Folders. Under "Folders" the user sees "All assets" first, then their own folders. Folders can be nested (a folder inside a folder).

Decisions already taken with the owner (do not re-discuss):

1. The **Asset** is the big layer. Anything generated or uploaded is an asset. An asset always belongs to a user and to a project (v1). It optionally belongs to exactly ONE folder.
2. **"All assets" is not a folder.** There is no row and no table for it. It is only the query "all assets of this project".
3. There is ONE concept: **Folder**. "Collection" and "folder" are the same thing. A sub-folder is a normal folder that has a `parent_id`. No separate table or type for sub-folders.
4. **One folder per asset** in v1 (a `folder_id` column on the asset, no join table). Tags may come later.
5. Folders are only an organization tool (a "division"). Media does not "start" inside a folder. It starts in the project; it is put in a folder only if the user chose one at generate/upload time, or moves it later.

Picture of the data (project level):
```
Project
 |- Project brief, Settings, Elements, Tools   (not part of this phase)
 '- Folders
     |- All assets          (a view: every asset of the project)
     |- Folder "Scene 1"    (root folder, parent_id = null)
     |    '- Folder "Shots"  (parent_id = id of "Scene 1")
     '- Folder "Props"      (root folder)
```

### 7.1.1 Architecture principles (decided, do not change)

The model is deliberately simple. The protections around it are NOT optional extras; they are what keeps the simple model safe.

1. **Only direct relations.** A folder knows only its direct parent (`parent_id`). An asset knows only its direct folder (`folder_id`). Nobody stores the chain above them. The full hierarchy is computed when needed. Example: asset X has `folder_id = Takes`; it does not know `Shots` or `Scene 1`.
2. **No copies of the hierarchy.** Never add `level`, `depth`, `path`, `root_id`, `ancestor_ids` or similar columns to `folders` or to the existing workflow-level table that is the Asset (D-24). Depth is computed at creation/move time from the flat list.
3. **Moving a folder is one change.** Changing the structure means changing ONE `parent_id`. No asset row is touched.
4. **Optional links.** `folder_id` is nullable (asset with no folder shows only in "All assets"). `parent_id` is nullable (root folder).
5. **Same project, enforced twice.** A folder and its parent must be in the same project. An asset and its folder must be in the same project. Enforced by the database (composite foreign keys, see 7.3) AND by the service layer (see 7.6). Never only by the service.
6. **No cycles.** Checked before every folder move (7.4).
7. **Limits.** Maximum depth (`FOLDER_MAX_DEPTH`, default 5) and maximum folders per project (`FOLDER_MAX_PER_PROJECT`, default 500). When MOVING a folder the depth check must include the height of the moved sub-tree: new parent depth + height of the moved folder's sub-tree must be <= the maximum (example: moving "Scene 1", which has 3 levels, under a folder at level 3 gives 3 + 3 = 6, which is rejected when the maximum is 5).
8. **Descendants are a query-time job.** Opening a folder with `includeDescendants=true` walks the tree in memory over the flat folder list, then runs one `IN (...)` query.
9. **No new asset system.** We do not create a second table for assets. The existing record that represents a generated or uploaded item receives `folder_id` (Path A in 7.3).

### 7.1.2 Naming rule and naming map (decided: NO renames in this plan)

Decision D-21: the product word is "Asset", but in the code and database the same concept is probably called `workflow` (and its files `media`). We keep the REAL names. We do NOT rename the table, its columns, its repository/service classes, its files, its routes or its env vars. Renaming is a separate, later project with its own plan (it needs compatibility aliases and a coordinated frontend change). Put one entry in BACKLOG.md: `RENAME-LATER: workflow -> asset (table, repository, routes). Needs a dedicated plan.`

How this works in practice:

- **Database and internal code keep existing names.** The `folder_id` column is added to the table SES0 identified (probably `workflow`). Methods for this concept are added to the EXISTING repository and service of that table (EXTENDED). Do not create an `AssetRepository`, an `AssetService`, an `assets` table or an `assets` view (D-22).
- **New things follow the repo's naming style.** New table `folders`, new column `folder_id`, new classes `FolderRepository` and `FolderService`. Check whether the repo uses singular or plural table names and snake_case or camelCase, and copy the style.
- **Public API vocabulary uses product words (D-23).** The NEW public endpoints and their JSON use `assets`, `folders`, `folderId`, because the frontend and the users think in those words and this vocabulary will not change when the table is renamed later. The mapping from a `workflow` row to an "asset" JSON object is done in ONE place (one serializer function, for example `toAssetDto(row)`) with a comment `// "asset" in product terms = workflow row`. Do not scatter the mapping.
- **Existing routes are untouched** (for example `/api/workflows/...`). Their names and response shapes do not change.
- If the repo ALREADY uses the word "asset" in some place, keep using it exactly where it is; do not unify.

Naming map template (SES0 fills it with real names and saves it as `docs/plan/NAMING_MAP.md`):

| Product concept | Real table / main columns | Repository / service | Existing routes | New public API word |
|---|---|---|---|---|
| Project | `projects` (verify) | (verify) | (verify) | `projects` |
| Asset (the user-visible item) | `workflow` (verify; add `folder_id`) | (verify, probably a workflow repository) | `/api/workflows/...` (verify) | `assets` |
| Asset file / version | `media` (verify) | (verify) | (verify) | not exposed in P3 |
| Folder (NEW) | `folders` (CREATED) | `FolderRepository`, `FolderService` (CREATED) | none | `folders` |
| Element | (verify) | `ElementRepository` | (verify) | unchanged |
| Character | (verify) | (verify) | (verify) | unchanged |

### 7.2 How to use Spec Kit in this phase

Run these in order. Each command writes files under `specs/<feature-name>/` (verify the real folder and command names you recorded in SETUP-2). When `SPEC_KIT = ON`, steps 1 to 5 are the PREP step of `05_SPEC_KIT_GUIDE.md` (done at the START of this phase session, followed by a STOP for the human), and step 6 (implement) is done after `GO`.

1. **specify**: give it the feature description in 7.2.1 (paste it, do not summarize it).
2. **clarify**: if it asks questions, answer them yourself using this section and section 12. Never ask the human. Typical questions and the answers:
   - Can an asset be in several folders? No (D-02).
   - Do assets of sub-folders show when opening a parent folder? Not by default; opt-in with `includeDescendants=true` (D-07).
   - What happens when deleting a folder? Blocked with 409 unless empty (D-06).
   - Can folders have the same name? Not among siblings; yes in different parents (D-15).
   - What is the maximum depth? From config, default 5 (D-12).
   - Is "All assets" a folder? No (D-03).
   - Can a user generate outside a project? Not in v1 (D-04).
   - Do deleted projects delete folders? Yes, folders belong to the project.
3. **plan**: constraints to give: "Use the existing stack and patterns found by SES0. No new dependencies. Additive migration only. Pure tree logic in its own module with unit tests. Repository methods always scoped by user. Routes follow the repo's existing route/validation/error conventions."
4. **tasks**: the generated task list must match F-T1 to F-T9 in 7.8. If it differs, keep this plan's order and merge duplicates. Do not drop the security tests.
5. **analyze**: run it, fix any inconsistency it reports in the spec files.
6. **implement**: run it task by task, but follow the loop in section 2.1 for each (failing test first, full `npm test`, secrets scan, self-review, one commit, report).

#### 7.2.1 Feature description to paste into `specify`

"Organize a project's assets with folders. A user can create, rename, move, reorder and delete folders inside a project. Folders can be nested up to a configurable depth. Every asset (generated or uploaded) belongs to one project and optionally to one folder. The special view 'All assets' lists every asset of the project and is not stored as a folder. A user can pick a folder when generating or uploading, and can move an asset to another folder or back to the project root. Folder deletion is refused unless the folder is empty. All access is private to the owning user; accessing another user's or another project's folder or asset always behaves as 'not found'. The change must be additive and must not break existing clients or data."

#### 7.2.2 User stories and acceptance scenarios (use in the spec)

1. Create folder: Given my project, when I create folder "Scene 1" at root, then it appears in the folder list with `parentId = null`.
2. Create sub-folder: Given folder "Scene 1", when I create "Shots" with `parentId` = Scene 1, then it is listed with that parent.
3. Rename: Given "Shots", when I rename it to "Takes", then the list shows the new name; renaming to a name used by a sibling fails with `FOLDER_NAME_TAKEN`.
4. Move folder: Given "Shots" under "Scene 1", when I move it under "Props", then `parentId` changes; moving "Scene 1" under its own child fails with `FOLDER_CYCLE`.
5. Reorder: Given 3 root folders, when I set a folder's `position`, then the list order follows `position`, then name.
6. Delete: Given an empty folder, delete succeeds (204). Given a folder with an asset or a sub-folder, delete fails with `FOLDER_NOT_EMPTY` and nothing is removed.
7. Generate/upload into folder: Given my folder, when I generate or upload with `folderId`, the new asset has that folder. Given a foreign folder id, the request fails with 404 and no credit is held and nothing is stored.
8. Move asset: Given an asset in folder A, when I move it to folder B (same project), it appears in B and not in A. Moving it to `null` returns it to root. Moving to a folder of another project fails with 404.
9. Listing: "All assets" shows everything; `folderId=<id>` shows only direct children; `folderId=none` shows unfiled assets; `includeDescendants=true` includes sub-folders.
10. Isolation: user B can never see, list, rename, move or delete anything of user A (always 404).

### 7.3 Schema (additive only)

Follow the migration folder, naming scheme and tool that SES0 reported. The SQL below shows INTENT. Adapt names and types to the repo (for example if ids are `text` or `bigint` instead of `uuid`, use the repo's type; if the project table is not called `projects`, use the real name).

**Table `folders`**
```sql
create table if not exists folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  project_id  uuid not null references projects(id) on delete cascade,
  parent_id   uuid null,
  name        text not null check (char_length(name) between 1 and 120),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- lets child rows point at (id, project_id) so a parent must be in the SAME project
  unique (id, project_id),
  foreign key (parent_id, project_id) references folders (id, project_id),
  check (parent_id is null or parent_id <> id)
);

create index if not exists folders_project_parent_idx
  on folders (project_id, parent_id, position);

-- sibling names unique per parent, case-insensitive; root siblings share the "all zeros" parent key
create unique index if not exists folders_sibling_name_uq
  on folders (project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
```
Notes the agent must understand:
- The self-referencing foreign key uses the DEFAULT delete rule (`NO ACTION`), NOT `RESTRICT`. Reason: when a whole project is deleted, `ON DELETE CASCADE` removes all its folders in one statement; `NO ACTION` is checked at the end of the statement, so the cascade can finish. `RESTRICT` would fail immediately.
- With a composite foreign key and a NULL `parent_id`, Postgres does not enforce the key (that is exactly what we want for root folders).
- `user_id` is copied from the authenticated user (never from the request body) and always equals the project owner.

**Asset side. Choose A or B using the SES0 conclusion.**

*Path A (SES0 confirmed: workflow row = asset).* Add to the existing asset-level table (the workflow table) ONLY these:
```sql
alter table <WORKFLOW_TABLE> add column if not exists folder_id uuid null;

-- an asset may only point to a folder of its OWN project
alter table <WORKFLOW_TABLE>
  add constraint <WORKFLOW_TABLE>_folder_same_project_fk
  foreign key (folder_id, project_id) references folders (id, project_id);

-- if project_id can be NULL on this table, the composite key would not be enforced; guard it:
alter table <WORKFLOW_TABLE>
  add constraint <WORKFLOW_TABLE>_folder_needs_project_ck
  check (folder_id is null or project_id is not null);

create index if not exists <WORKFLOW_TABLE>_project_folder_idx
  on <WORKFLOW_TABLE> (project_id, folder_id, created_at desc);
```
- Do NOT create a new `assets` table, view or alias. Do NOT touch media/version tables. `<WORKFLOW_TABLE>` in the SQL above is the REAL name of the table that `NAMING_MAP.md` lists as the Asset (probably `workflow`). Write that real name in the migration. It is NOT a new table, its name must NOT become `assets`, and you keep its name unchanged (D-21).
- `add constraint` has no `IF NOT EXISTS` in Postgres. Make the migration safe to re-run by wrapping it in a `do $$ begin ... exception when duplicate_object then null; end $$;` block, or follow the repo's migration tool convention for idempotence.
- If the table is big, use `not valid` then `validate constraint` in a separate step (all `folder_id` are null at first, so validation is instant; this is optional).
- If the migration tool wraps migrations in a transaction, do not use `create index concurrently`.

*Path B (SES0 refuted or partial).* Write the smallest additive change that gives ONE row per user-visible item with `user_id`, `project_id`, `folder_id`, following the same constraints as above. If making that work requires renaming, moving or rewriting existing data: escalate (reason 1.5.4) and stop P3.

**Direct `user_id` on the existing Asset table (probably `workflow`).** If SES0 shows that table has no `user_id`: add `user_id uuid null` in one migration, backfill from the project owner in a separate idempotent migration, and verify the backfill (count of rows where `user_id is null` must be 0) before any code relies on it. Enforcing `NOT NULL` is a LATER migration, not part of this phase (record it in BACKLOG.md). Reason: keeps rollback safe.

**`project_id` on assets.** Keep whatever it is today. Do not make it nullable in this phase (open product question D-04). The schema above does not block making it nullable later.

**Rollback notes (put in the migration file as comments):** to roll back, drop the asset constraints, drop the `folder_id` column, then drop the `folders` table. No existing data is changed by the migration.

### 7.4 Pure tree logic (no database): `folderTree` module

Create one small module (suggested path `src/domain/folderTree.js`; follow the repo's folder conventions). It takes plain arrays of `{ id, parentId }` objects and has NO database or framework imports. It is easy to test and it is where the cycle and depth bugs would live.

Functions (all pure):

- `indexById(folders)` -> `Map<id, folder>`.
- `indexChildren(folders)` -> `Map<parentId|null, folder[]>`. The key for root folders is `null`.
- `getAncestorIds(byId, folderId)` -> array of ids from the direct parent up to the root. Must protect against bad data: keep a `visited` set; if an id repeats, throw an Error ("cycle detected in stored data").
- `getDepth(byId, folderId)` -> number of folders from the root down to this folder, counting itself. A root folder has depth 1.
- `getSubtreeHeight(children, folderId)` -> the longest chain downward, counting the folder itself. A folder with no children has height 1.
- `collectDescendantIds(children, folderId)` -> Set of ids including `folderId` itself.
- `wouldCreateCycle(byId, movingId, newParentId)` -> true if `newParentId === movingId` OR `movingId` appears in `getAncestorIds(byId, newParentId)`. If `newParentId` is `null`, false.
- `wouldExceedDepth(byId, children, movingId, newParentId, maxDepth)` -> `parentDepth + getSubtreeHeight(children, movingId) > maxDepth`, where `parentDepth` is 0 when `newParentId` is null, else `getDepth(byId, newParentId)`.
- `depthForNewChild(byId, parentId)` -> 1 when `parentId` is null, else `getDepth(byId, parentId) + 1` (used when creating).

**Test vectors** (write these tests FIRST in F-T1). Data: A (root), B (parent A), C (parent B), D (root).

| Call | Expected |
|---|---|
| `getDepth(A)`, `getDepth(B)`, `getDepth(C)`, `getDepth(D)` | 1, 2, 3, 1 |
| `getSubtreeHeight(A)`, `(B)`, `(C)`, `(D)` | 3, 2, 1, 1 |
| `getAncestorIds(C)` | `[B, A]` |
| `collectDescendantIds(A)` | `{A, B, C}` |
| `wouldCreateCycle(moving=A, newParent=C)` | true |
| `wouldCreateCycle(A, B)` | true |
| `wouldCreateCycle(A, A)` | true |
| `wouldCreateCycle(A, D)` | false |
| `wouldCreateCycle(C, A)` | false (moving C under A is fine) |
| `wouldCreateCycle(B, null)` | false |
| `wouldExceedDepth(moving=D, newParent=C, max=3)` | true (3 + 1 > 3) |
| `wouldExceedDepth(D, B, 3)` | false (2 + 1 = 3) |
| `wouldExceedDepth(A, D, 3)` | true (1 + 3 > 3) |
| `wouldExceedDepth(A, null, 3)` | false (0 + 3 = 3) |
| stored data with a loop (X parent Y, Y parent X) -> `getAncestorIds(X)` | throws |

### 7.5 API contract

Match the repo's route prefix, response envelope, naming style (camelCase vs snake_case), validation library and error format. The shapes below show intent. Where the repo already has a convention, the repo wins.

**Folder object**
```json
{
  "id": "6f1c...-uuid",
  "projectId": "a2b3...-uuid",
  "parentId": null,
  "name": "Scene 1",
  "position": 0,
  "assetCount": 12,
  "createdAt": "2026-10-07T10:00:00.000Z",
  "updatedAt": "2026-10-07T10:00:00.000Z"
}
```
`assetCount` = number of assets DIRECTLY in that folder (not descendants).

| Method + path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/projects/:projectId/folders` | none | 200 `{ "items": [Folder, ...] }` (flat list, ordered by `position`, then `name`) | The frontend builds the tree from `parentId`. No recursive SQL. Compute `assetCount` with ONE grouped query, not one query per folder. |
| `POST /api/projects/:projectId/folders` | `{ "name": "Scene 1", "parentId": null }` (`parentId` optional) | 201 Folder | `position` = (largest sibling position) + 1. |
| `PATCH /api/folders/:folderId` | any of `{ "name", "parentId", "position" }` | 200 Folder | Rename, move, reorder. `projectId` can never be changed. |
| `DELETE /api/folders/:folderId` | none | 204 | 409 `FOLDER_NOT_EMPTY` if it has assets or sub-folders. |
| `GET /api/projects/:projectId/assets` | `folderId` (uuid or `none`), `includeDescendants` (`true`/`false`), `limit`, `cursor` | 200 `{ "items": [...], "nextCursor": "..." or null }` | See listing rules below. |
| `PATCH /api/assets/:assetId/folder` | `{ "folderId": "uuid" or null }` | 200 asset | A DEDICATED route (see 7.6 rule 9). `:assetId` is the id of the workflow-level row (naming map, D-23). |
| existing generate / upload routes | add optional `folderId` | unchanged | Validate `folderId` early (7.7). |

**Naming note:** the new endpoints say `assets` (product vocabulary, D-23) even though the table is probably `workflow` (D-21). The mapping row -> asset JSON lives in one serializer function. Existing `/api/workflows/...` routes and their responses stay exactly as they are.

**Listing rules (assets)**
- No `folderId` -> "All assets": everything in the project.
- `folderId=<uuid>` -> only assets whose `folder_id` equals it (direct children).
- `folderId=none` -> only assets with `folder_id` null.
- `folderId=<uuid>&includeDescendants=true` -> that folder plus all its sub-folders. Compute the set of ids with `collectDescendantIds` from the in-memory flat folder list, then query `folder_id IN (...)`.
- `includeDescendants` is ignored when `folderId` is absent or `none`.
- Invalid `folderId` (neither uuid nor `none`) -> 400/422 with the repo's validation error.
- A syntactically valid `folderId` that is not yours or not in this project -> 404.
- Order: newest first (`created_at desc, id desc`). Pagination: `limit` default 50, maximum from config `ASSET_LIST_MAX_LIMIT` (default 200). `cursor` is an opaque string (base64 of the last `created_at` and `id`).
- COMPATIBILITY: first check if `GET /api/projects/:projectId/assets` (or the old listing used by the frontend, e.g. `findByProject`, `project-data`) already exists. If a route already exists, keep its current response shape for requests that carry none of the new parameters (EXTENDED). Never change the response shape of `GET /api/workflows/project-data/:projectId` (the element-vision frontend uses it). If no such route exists, create the new one (CREATED).

**Error table** (use the repo's error class and envelope; codes below are the ones to add)

| Situation | HTTP | `code` |
|---|---|---|
| Project, folder or asset missing OR not yours OR in another project | 404 | the repo's existing not-found code |
| Invalid folder name (empty after trim, longer than 120, control characters) | 422 | `FOLDER_NAME_INVALID` |
| Sibling already has that name | 409 | `FOLDER_NAME_TAKEN` |
| Move would create a cycle | 422 | `FOLDER_CYCLE` |
| Depth would exceed `FOLDER_MAX_DEPTH` | 422 | `FOLDER_DEPTH_EXCEEDED` |
| Project already has `FOLDER_MAX_PER_PROJECT` folders | 422 | `FOLDER_LIMIT_REACHED` |
| Delete a folder that has assets or sub-folders | 409 | `FOLDER_NOT_EMPTY` |
| Bad query parameter or body shape | 400 or 422 (repo convention) | the repo's validation code |

**Name rules:** `name.normalize('NFC').trim()`; length 1 to 120 after trimming; reject control characters (`/[\u0000-\u001F\u007F]/`); keep inner spaces as they are. Do not silently change the name beyond trim + NFC.

**Database races (important).** Two requests can pass the application checks at the same time. The database is the final judge: catch the unique-violation error (Postgres code `23505` on `folders_sibling_name_uq`) and answer 409 `FOLDER_NAME_TAKEN`. Catch the foreign-key violation (`23503`) on delete and answer 409 `FOLDER_NOT_EMPTY`. A concurrent double-move creating a cycle is a rare race; accept it for v1, add a BACKLOG item "wrap folder moves in a transaction with row locks" unless the repo already uses a direct transactional client.

### 7.6 Security rules (each one must have a test)

1. `assertOwns("project", projectId)` runs FIRST on every project-scoped route, before any folder or asset query.
2. Any `folderId` or `parentId` coming from the client is loaded with a query scoped by `(id, project_id, user_id)`. If it is not found, answer 404. Same 404 for "does not exist" and "belongs to someone else".
3. Routes without a project in the path (`PATCH/DELETE /api/folders/:folderId`): first load the folder scoped by `(id, user_id)` -> 404 if missing; then run `assertOwns("project", folder.projectId)`.
4. Moving a folder: reject cycles with `wouldCreateCycle`; reject depth with `wouldExceedDepth`. The new parent must be in the same project.
5. Moving an asset: the asset and the target folder must belong to the same user and the same project.
6. Generate / upload with `folderId`: validate the folder BEFORE any credit hold and BEFORE storing any bytes.
7. `user_id` and `project_id` of a new row always come from the server (authenticated user, route parameter checked by `assertOwns`). Ignore these fields if the client sends them in a body.
8. Folder write routes use the existing rate limiter.
9. **Mass-assignment protection.** Do NOT add `folderId` to the existing generic asset/workflow update route (`PATCH /api/workflows/workflows/:id`). Reason: that route is also reachable through the (restricted) internal-secret path; a generic update accepting `folderId`, `projectId`, or `userId` from the body would let those be changed. Use the DEDICATED route for folder moves. Also make sure the generic update route ignores or rejects `folderId`, `folder_id`, `projectId`, `project_id`, `userId`, `user_id` in the body (add a test that sending them changes nothing).
10. FolderRepository must NOT use the unscoped `BaseRepository.deleteById`. Implement scoped methods (`deleteOwned(id, userId)`), so the D3(5) problem is not repeated.
11. Do not leak counts or names across users: `assetCount` is computed only over the caller's own project assets.

### 7.7 Other behaviors

- **Generate/upload validation order:** authenticate -> `assertOwns("project")` -> validate body -> validate `folderId` (scoped, same project) -> THEN hold credits / accept bytes / queue the job. Test: with a foreign `folderId` the credit hold function is called 0 times.
- **Assets created later by a worker.** If the asset row is created inside a worker, the job data must carry `folderId`. In the worker, re-check that the folder still exists; if it does not (an empty folder may have been deleted while the job waited), create the asset with `folder_id = null` and log a warn. Never fail a job that is already paid because of a folder.
- **Project deletion.** Check how projects are deleted today (cascade, soft delete, manual cleanup, from SES0). Make sure the new foreign keys do not make project deletion fail. If the repo has a project-deletion test, it must still pass; if not, add one for a project that has folders.
- **Existing assets** keep `folder_id = null` and appear in "All assets". No backfill.
- **Old clients** that know nothing about folders keep working unchanged.

### 7.8 Task breakdown (each task = the loop in 2.1, one commit, one report)

Before F-T1, read `docs/plan/NAMING_MAP.md` (made by SES0). All tasks use REAL names from that map in code and SQL, and product words only in the public API.

Commit message: `phase3(F-T<n>)`. After each task update STATE.md.

**F-T1: pure tree module + unit tests**
- Files: the `folderTree` module and its test file.
- Steps: write all tests from the 7.4 vectors first (they fail: module missing); implement; make them pass.
- DoD: all vectors pass; no database or framework import in the module; every function documented with one comment line.

**F-T2: migration**
- Files: one migration for `folders`; one that adds `folder_id` to the EXISTING Asset table from `NAMING_MAP.md` (Path A or B); a user_id backfill migration only if SES0 showed `user_id` missing.
- Steps: write following the repo's migration convention; make them idempotent; add rollback comments; if the repo has migration tests or a schema snapshot, update them; verify with whatever hermetic check exists (for example SQL lint or a schema test). If you cannot apply the migration (no DB), mark `NOT-RUN` and give the human the exact command.
- DoD: files exist; additive only (search the SQL for `drop`, `rename`, `alter column`, `type`: none); constraints named; `NO ACTION` used on the folder foreign keys; rollback notes present.

**F-T3: FolderRepository**
- Methods (all take `userId`; names are suggestions): `listByProject(projectId, userId)`, `findOwned(folderId, userId)`, `findOwnedInProject(folderId, projectId, userId)`, `countByProject(projectId, userId)`, `create(data)`, `updateOwned(folderId, userId, patch)`, `deleteOwned(folderId, userId)`, `countAssetsByFolder(projectId, userId)` (one grouped query returning folderId -> count), `countChildren(folderId)`, `countAssetsIn(folderId)`.
- Rules: every query includes `user_id`; extend `BaseRepository` ONLY if it does not expose unscoped delete/list through this class (otherwise compose instead of inheriting, or override and block them).
- Tests: with the repo's DB test double: user B cannot find/update/delete user A's folder; list returns only the project's folders.
- DoD: no method exists without a user scope; tests pass.

**F-T4: FolderService (business rules)**
- Methods: `list`, `create`, `update` (rename/move/reorder), `remove`, `assertFolderUsable(folderId, userId, projectId)` (used later by generate/upload/move).
- Rules: normalize + validate name; sibling name check (and handle DB `23505`); depth/limit checks from config (`FOLDER_MAX_DEPTH`, `FOLDER_MAX_PER_PROJECT`); cycle check on move using the pure module with the project's flat list; delete refuses if `countChildren + countAssetsIn > 0` (and handles DB `23503`); unknown or foreign ids -> the repo's not-found error.
- Tests (use fakes for the repository): all error-table rows; happy paths; cross-user and cross-project cases.
- DoD: every error code in 7.5 is produced by a test.

**F-T5: folder routes**
- Files: routes/controller for the four folder endpoints; request validation; rate limit; wiring in the app/router.
- Rules: follow the repo's controller style; `assertOwns("project")` first; use the service only; response shapes as in 7.5.
- Tests (HTTP level, same helpers as other route tests): the 10 acceptance scenarios from 7.2.2 that concern folders (1 to 6 and 10), plus: unauthenticated -> 401; invalid body -> validation error; response never contains another user's data.
- DoD: all pass; folder routes are mounted behind normal JWT auth only (they must NOT be reachable through the internal-secret path: add a test that, with `INTERNAL_AUTH_ENABLED=true` and the secret, a folder route request is ignored).

**F-T6: move asset to folder (dedicated route) + mass-assignment guard**
- Files: the dedicated route and service method; a guard in the existing generic update route.
- Steps: `PATCH /api/assets/:assetId/folder` with `{ folderId }`; the code behind it uses the EXISTING repository of the asset-level table (naming map). Load the asset scoped by `(id, user_id)` -> 404; if `folderId` not null call `assertFolderUsable(folderId, userId, asset.projectId)`; update `folder_id`. Then add tests for the generic route ignoring/rejecting `folderId`, `projectId`, `userId` in the body.
- Tests: scenario 8 (move, move to null, foreign folder 404, folder of another project 404, other user's asset 404); mass-assignment test; internal-secret path cannot reach this route.
- DoD: all pass.

**F-T7: asset listing with folder filters and pagination**
- Steps: implement per 7.5 listing rules. For `includeDescendants`, load the project's flat folder list, compute the id set in memory, query `folder_id IN (...)`. Pagination with the cursor.
- Tests: scenario 9 (all, direct folder, `none`, descendants, pagination across 2 pages, cursor round trip, invalid `folderId`, foreign `folderId` -> 404); legacy listing responses unchanged (snapshot of old shape if it existed).
- DoD: all pass; no N+1 queries (assert query count in a test if the repo's DB double allows it, else explain in the report).

**F-T8: folderId on generate/upload + worker edge case**
- Steps: find every generate route (`rg -n "generate|ingest|upload" src/routes`). Add optional `folderId` to the validation. Call `assertFolderUsable` right after body validation and BEFORE credit hold and before storing bytes. Pass `folderId` into job data if assets are created by a worker; in the worker re-check and fall back to null.
- Tests: foreign `folderId` -> 404 and `hold_credits` spy called 0 times and storage `upload` spy called 0 times; valid `folderId` -> asset created with that folder; no `folderId` -> same behavior as before (regression); worker with a deleted folder -> asset created with null folder, no job failure, warn logged.
- DoD: all pass for every generate/upload route found (list them in the report with `file:line`).

**F-T9: docs, regression, final cross-check**
- Update `docs/release/frontend-changes-needed.md` (see 7.9).
- Document new env vars (`FOLDER_MAX_DEPTH`, `FOLDER_MAX_PER_PROJECT`, `ASSET_LIST_MAX_LIMIT`) with defaults in `docs/release/phase0-rc.md`.
- Regression: run the full `npm test`; run the project-deletion check (7.7); confirm `rg -n "console\." <all files touched in P3>` prints nothing; confirm no unscoped repository method is used by folder code (`rg -n "deleteById" <folder files>` prints nothing).
- Write `docs/plan/reports/P3-SUMMARY.md`: endpoints added, files added/changed, env vars, migration order, manual checks for the human.
- DoD: summary written; gate (section 10) passed.

### 7.9 Rollout and the frontend document

Deploy order: (1) apply the migrations, (2) deploy the backend, (3) deploy the frontend. Because the change is additive, old frontends keep working while the new one is rolled out.

In `docs/release/frontend-changes-needed.md` add a section "Folders" with:
1. Project sidebar structure: Project brief, Settings, Elements, Tools, Folders. Under Folders: "All assets" first (a fixed entry that calls the assets listing with no `folderId`), then the user's folders as a tree.
2. How to build the tree: call `GET /api/projects/:id/folders` once, group by `parentId` on the client. Show `assetCount` next to each folder (direct assets only).
3. Breadcrumb example: `All / Scene 1 / Shots` built from the ancestors in the same flat list.
4. Every endpoint with request and response examples (copy from 7.5).
5. The error codes and what to show: `FOLDER_NOT_EMPTY` ("Move or delete the content first"), `FOLDER_NAME_TAKEN`, `FOLDER_CYCLE`, `FOLDER_DEPTH_EXCEEDED`, `FOLDER_LIMIT_REACHED`.
6. When generating or uploading, send `folderId` if a folder is currently open; omit it when "All assets" is open.
7. Moving an asset: use the dedicated route; `folderId: null` means "back to the project root".
8. Clarify for the UI: opening a folder shows direct assets only; offer a "include sub-folders" toggle that sets `includeDescendants=true`.

### 7.10 Explicitly out of scope for P3 (do not build, only note in BACKLOG.md)

- The Global library: Home, My generations (all assets of the user across projects), My elements, My favorites (needs a `favorites` table). Nullable `project_id` is an open product question (D-04).
- Sharing and collaboration (`project_members`).
- Merging Characters and Elements into one concept with a `type` (two separate services today).
- Many-to-many folders and tags.
- Element import across projects (when built later: COPY, not reference, D-05).
- Redesigning asset versions (media rows). Only if SES0 proves versions are missing, and then as a separate proposal.
- Renaming `workflow` to `asset` (table, columns, repository, routes). Later, as its own project (D-21). Only the BACKLOG entry `RENAME-LATER` is created.
- Enforcing `NOT NULL` on the asset `user_id` (later migration, after verifying the backfill).

---

## Phase end: gate and acceptance test

1. When every task above is DONE, BLOCKED or SKIPPED, run the phase gate (`00_CORE.md` section 10).
2. Phase acceptance test. Run each check and paste the results (command or test name + result, tagged VERIFIED / NOT-RUN) into `docs/plan/reports/PHASE-P3-GATE.md`:

Always: full hermetic `npm test` passes; `git status --short` clean (except `docs/plan/scratch/`); nothing pushed; every task of the phase has a report with tagged claims.

| Phase | Extra checks |
|---|---|
| P3 | (1) Migrations are additive (`rg -n -i "drop|rename|alter column" <new migration files>` prints nothing) and use `NO ACTION` on folder foreign keys. (2) All `folderTree` test vectors of 7.4 pass. (3) Every acceptance scenario 1 to 10 of 7.2.2 has at least one test (list test names). (4) Every cross-tenant and cross-project case returns 404 (test names). (5) Generate/upload with a foreign `folderId` calls `hold_credits` 0 times (test name). (6) The mass-assignment test passes. (7) The project-deletion check passes. (8) `rg -n "console\." <files touched in P3>` prints nothing. (9) New env vars are documented. (10) `docs/release/frontend-changes-needed.md` has the Folders section. (11) The migration was NOT applied to any real database (NOT-RUN note with the command for the human). |

If any check fails: fix it inside the phase (same loop), re-run the phase acceptance test, then report. Do not stop with a failed check unless a stop reason of 1.5 applies.

3. Write the gate report, update STATE.md with `Next step: FINAL (human gives you `06_FINAL_AND_P4.md` in a new session)`, print a summary (max 15 lines) and STOP.
