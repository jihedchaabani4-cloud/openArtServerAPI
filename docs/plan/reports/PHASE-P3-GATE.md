# Phase P3 Gate Report: Folders Feature

## 1. Phase Gate Verification Results

| Check # | Requirement | Status | Verification Detail / Proof |
|---|---|---|---|
| 1 | Migrations additive & `NO ACTION` on folder FKs | VERIFIED | Active SQL in `migrations/008_create_folders_and_extend_workflow.sql` has 0 `DROP`, 0 `RENAME`, 0 `ALTER COLUMN`. FKs `folders_parent_same_project_fk` and `workflow_folder_same_project_fk` use default `NO ACTION`. Verified via node AST/token parser and `tests/unit/folderMigrationSchema.test.js`. |
| 2 | All `folderTree` test vectors of 7.4 pass | VERIFIED | 25/25 passing tests in `tests/unit/folderTree.test.js`: `indexById and indexChildren`, `getDepth`, `getSubtreeHeight`, `getAncestorIds`, `collectDescendantIds`, `wouldCreateCycle`, `wouldExceedDepth`, `depthForNewChild`. |
| 3 | Acceptance scenarios 1 to 10 of 7.2.2 tested | VERIFIED | Scenario 1: `Scenario 1: creates root folder successfully (POST /api/projects/:id/folders)`<br>Scenario 2: `Scenario 2: creates sub-folder successfully with parentId`<br>Scenario 3: `Scenario 3: renames folder successfully (PATCH /api/folders/:id)`<br>Scenario 4: `Scenario 4: deletes empty folder successfully (DELETE /api/folders/:id)`<br>Scenario 5: `Scenario 5: rejects deleting folder with assets with 409 FOLDER_NOT_EMPTY`<br>Scenario 6: `Scenario 6: lists folders as flat array with direct assetCount`<br>Scenario 7: `Scenario 7: depth limit check enforces maximum configured depth`<br>Scenario 8: `Scenario 8.1..8.6: moves asset to folder/null, refuses foreign/cross-project`<br>Scenario 9: `Scenario 9.1..9.6: asset listing with folderId, none, descendants, cursor pagination`<br>Scenario 10: `Scenario 10: rejects cyclic folder move with FOLDER_CYCLE` |
| 4 | Every cross-tenant and cross-project case returns 404 | VERIFIED | `returns 404 when User B tries to list User A's folders (cross-tenant)`<br>`returns 404 when User B tries to update User A's folder (cross-tenant)`<br>`returns 404 when User B tries to delete User A's folder (cross-tenant)`<br>`refuses moving asset to foreign folder (cross-tenant) -> 404`<br>`refuses moving asset to a folder of another project of the same user -> 404`<br>`refuses moving another user's asset to root (cross-tenant) -> 404`<br>`TEST R4-46: GET /api/projects/:projectId/assets for foreign project returns 404`<br>`foreign user cannot delete another user's project that contains folders (returns 404)` |
| 5 | Foreign `folderId` on generate/upload calls `hold_credits` 0 times | VERIFIED | `Scenario 8.4: generation refuses foreign or non-existent folderId with 404 before credit hold` in `tests/integration/generationWithFolder.test.js` (`assert.equal(holdCreditsCalls.length, 0)`). |
| 6 | Mass-assignment test passes | VERIFIED | `mass-assignment guard: PATCH /api/workflows/workflows/:id ignores or rejects folderId/projectId/userId` in `tests/integration/assetFolderMove.test.js` (returns 400). |
| 7 | Project-deletion check passes | NOT-RUN | Downgraded to NOT-RUN: Hermetic test environment runs against mock Supabase client; true Postgres ON DELETE CASCADE behavior is not tested without running against live database engine (see Check 11). Mock validation passes in `tests/boundary/projectCascadeFoldersBoundary.test.js`. |
| 8 | Zero `console.*` in P3 touched files | VERIFIED | `Get-ChildItem -Path <P3 code files> | Select-String "console\."` returned 0 hits. Structured logger used exclusively. |
| 9 | New environment variables documented | VERIFIED | `FOLDER_MAX_DEPTH`, `FOLDER_MAX_PER_PROJECT`, and `ASSET_LIST_MAX_LIMIT` documented with default values in `docs/release/phase0-rc.md` Sections 3 and 5.2. |
| 10 | Frontend handoff document has Folders section | VERIFIED | Section `## (i) Folders (Phase 3)` documented in `docs/release/frontend-changes-needed.md` with sidebar structure, tree construction, breadcrumbs, contracts, and error mapping. |
| 11 | Migration applied to real database | NOT-RUN | Hermetic isolation strictly preserved (no real DB connected). Application command for human: `psql "$DATABASE_URL" -f migrations/008_create_folders_and_extend_workflow.sql`. |

## 2. Test Suite Baseline Verification
- Total tests executed: 660
- Passing tests: 651
- Failing tests: 9 pre-existing baseline failures (0 regressions) [VERIFIED: task-1950 log]

### Real Output of `comm -23` and `comm -13` on Leaf Failures:
Comparing baseline (`task-282.log`) vs current test run (`task-1950.log`):
```text
=== comm -23 (in baseline task-282, not in current task-1950) ===
<empty: 0 differences>

=== comm -13 (in current task-1950, not in baseline task-282) ===
<empty: 0 differences>
```

### Clarification on `countParameterBoundary` vs `countBehaviorBoundary`:
The file on disk is named `tests/boundary/countBehaviorBoundary.test.js`. Inside the test file, the top-level suite title is `RC1.1-R3 — Count Parameter Current Server Behavior Test`. In logs and reports, the suite title is reported as `Count Parameter`, while the file name is `countBehaviorBoundary`. Both denote the identical 3 tests clamping count on catalog image models.

### Exact 9 Baseline Failures:
1. `tests/boundary/countBehaviorBoundary.test.js` | `TEST 1: top-level count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200`
2. `tests/boundary/countBehaviorBoundary.test.js` | `TEST 2: parameters.count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200`
3. `tests/boundary/countBehaviorBoundary.test.js` | `TEST 3: count: 4 on all catalog image models (gpt_image_2, seedream_v5, nanobana_pro) — all clamp silently to 1`
4. `tests/boundary/promptOptimizationBoundary.test.js` | `TEST 3: Identity & Billing: forwards authenticated userId to promptService`
5. `tests/boundary/promptOptimizationBoundary.test.js` | `TEST 5: Rate Limiting: blocks requests exceeding limit with 429 and Retry-After`
6. `tests/boundary/uploadHardeningD25Boundary.test.js` | `/health endpoint exposes redis readiness status without crashing`
7. `tests/boundary/v2WorkflowRunBoundary.test.js` | `TEST 1: Default config: POST /api/v2/workflows/run is disabled and returns 404`
8. `tests/boundary/v2WorkflowRunBoundary.test.js` | `TEST 2: Feature flag enabled: allows execution only when ENABLE_V2_WORKFLOW_RUN_ENDPOINT=true`
9. `tests/boundary/v2WorkflowRunBoundary.test.js` | `TEST 3: GET /runs/:run_id returns 404 when requested by a different user`

## 3. Security & Hygiene
- Secrets scan on `git diff --cached`: Clean [VERIFIED].
- Repository scoping: All folder operations strictly project- and user-scoped. Unscoped repository methods forbidden and blocked [VERIFIED].
- Internal secret isolation:
  - `/api/folders`: Verified 401 via `tests/integration/folderRoutes.test.js` (`ignores internal secret and returns 401 for folder routes even if INTERNAL_AUTH_ENABLED=true`) [VERIFIED].
  - `/api/assets/:assetId/folder`: Verified 401 via `tests/integration/assetFolderMove.test.js` (`ignores internal secret and returns 401 even if INTERNAL_AUTH_ENABLED=true`) [VERIFIED].
- Changes under `my-app/`: 0 files modified [VERIFIED].
