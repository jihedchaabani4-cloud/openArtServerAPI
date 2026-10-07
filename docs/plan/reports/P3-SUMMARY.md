# P3 Summary: Folders Feature Implementation

## 1. Endpoints Added & Modified
- `GET /api/projects/:projectId/folders`: Returns flat list of project folders with direct `assetCount` badges, ordered by `position`, then `name`.
- `POST /api/projects/:projectId/folders`: Creates folder under optional `parentId`. Position is auto-calculated (`max(sibling.position) + 1`).
- `PATCH /api/folders/:folderId`: Updates folder properties (`name`, `parentId`, `position`). Validates sibling naming uniqueness and cycle prevention. `projectId` is immutable.
- `DELETE /api/folders/:folderId`: Deletes empty folder. Returns 409 `FOLDER_NOT_EMPTY` if folder contains child folders or direct assets.
- `GET /api/projects/:projectId/assets`: Lists project assets with filters (`folderId`, `folderId=none`, `includeDescendants=true`) and opaque base64 cursor pagination.
- `PATCH /api/assets/:assetId/folder`: Dedicated route for moving asset workflow row to a target folder (`folderId: null` moves back to root).
- `POST /api/images/generate`: Extended with optional `folderId`, validated via `assertFolderUsable` before credit hold and execution.
- `POST /api/video/generate`: Extended with optional `folderId`, validated via `assertFolderUsable` before credit hold and execution.
- `POST /api/assets/upload`: Extended with optional `folderId`, validated before media ingestion.
- `PATCH /api/workflows/workflows/:id`: Hardened with mass-assignment defense rejecting `folderId`, `folder_id`, `projectId`, `project_id`, `userId`, `user_id`.

## 2. Files Added & Touched
### Core Domain & Data
- `src/domain/folderTree.js`: Pure module for tree algorithms (indexing, depth, height, cycle detection, descendants).
- `src/db/FolderRepository.js`: Scoped repository enforcing `userId` and `projectId` on all operations. Explicitly throws on unscoped base methods.
- `src/domain/folder/FolderService.js`: Business rules, validation, depth/quota ceilings, cascade verification.
- `src/domain/assetDto.js`: Centralized serializer mapping internal database workflow rows to public asset contract.
- `src/db/WorkflowRepository.js`: Added `updateFolderId`, `listProjectAssets`, and folder/user persistence in `createWorkflow`.
- `src/domain/generation/GenerationService.js`: Added `listProjectAssets` with in-memory descendant expansion and cursor pagination.
- `src/v2/services/v1StorageBridge.js`: Worker fallback resetting missing/deleted folder references to `null`.
- `src/platform/media-ingestion/MediaIngestionService.js`: Propagates `folderId` and `userId` to created upload workflow rows.

### Controllers & Routing
- `controllers/foldersController.js`: HTTP handlers for folder CRUD and tree retrieval.
- `routes/folders.js`: Router mounting folder routes behind standard JWT auth with rate limiting.
- `routes/projects.js`: Mounted `GET /api/projects/:projectId/folders`, `POST /api/projects/:projectId/folders`, and `GET /api/projects/:projectId/assets`.
- `routes/assets.js`: Mounted dedicated `PATCH /:assetId/folder` and updated `POST /upload`.
- `controllers/workflowsController.js`: Mass-assignment guards on generic workflow update.
- `src/api/routes.js`: Wired `foldersRouter`.

### Migrations & Configuration
- `migrations/008_create_folders_and_extend_workflow.sql`: Additive migration for `folders` table, `workflow.folder_id`, `workflow.user_id`, indexes, and RLS.
- `src/config/rateLimitPolicies.js`: Added `folderRead` and `folderWrite` rate-limiting policies.

### Tests
- `tests/unit/folderTree.test.js`: 25 pure tree tests.
- `tests/unit/folderMigrationSchema.test.js`: Schema validation against `database_schema.sql`.
- `tests/boundary/workflowOwnershipNullProject.test.js`: Multi-tenant boundary tests for `user_id IS NULL` backfill handling.
- `tests/integration/folderRepository.test.js`: 16 repository tests.
- `tests/unit/folderService.test.js`: 15 domain service tests.
- `tests/integration/folderRoutes.test.js`: 15 HTTP integration tests.
- `tests/integration/assetFolderMove.test.js`: 15 move and mass-assignment tests.
- `tests/integration/assetListingWithFolders.test.js`: 11 listing and pagination tests.
- `tests/integration/generationWithFolder.test.js`: 6 generation and upload validation tests.
- `tests/boundary/projectCascadeFoldersBoundary.test.js`: 2 project deletion cascade boundary tests.
- `tests/boundary/routeOwnershipAuditBoundary.test.js`: Extended with `TEST R4-46`.

## 3. Environment Variables Added
- `FOLDER_MAX_DEPTH`: Maximum depth of folder nesting within a project (default `3`).
- `FOLDER_MAX_PER_PROJECT`: Maximum number of folders permitted per project (default `100`).
- `ASSET_LIST_MAX_LIMIT`: Maximum allowable limit parameter for asset listing endpoint (default `200`).

## 4. Database Migration Order & Execution
- Migration file: `migrations/008_create_folders_and_extend_workflow.sql`.
- Safety status: Additive only. No tables or columns dropped or renamed. Uses `NO ACTION` on composite foreign keys.
- Application status: [NOT-RUN] Hermetic test environment does not connect to live database.
- Production/Staging execution command:
  ```bash
  psql "$DATABASE_URL" -f migrations/008_create_folders_and_extend_workflow.sql
  ```

## 5. Manual Checks for Human
1. Verify `008_create_folders_and_extend_workflow.sql` on a staging Supabase instance before running on production.
2. Verify that existing workflows without `user_id` are backfilled from `project.user_id`.
3. Verify that old clients continue calling `/api/workflows/project-data/:projectId` without regression.
