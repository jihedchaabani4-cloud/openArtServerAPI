# F-T8 Report: Validation on Generation and Upload Routes + Worker Fallback

## 1. Summary of Changes
- Integrated `folderService.assertFolderUsable(folderId, projectId, userId)` into:
  - `controllers/imageController.js` (`POST /api/image/generate`): validates `folderId` BEFORE credit hold/reserve; attaches `folder_id` and `user_id` to created workflow.
  - `controllers/videoController.js` (`POST /api/video/generate`): validates `folderId` BEFORE credit hold/reserve; attaches `folder_id` and `user_id` to created workflow.
  - `routes/assets.js` (`POST /api/assets/upload`): validates `folderId` BEFORE media ingestion; passes `folderId` to ingestion service.
  - `src/platform/media-ingestion/MediaIngestionService.js`: accepts `folderId` in options; sets `folder_id` and `user_id` on auto-created UPLOAD workflow.
- Implemented worker fallback in `src/v2/services/v1StorageBridge.js:createV1Placeholder`:
  - When worker creates placeholder with `folderId`, verifies folder still exists. If folder was deleted while async job was in flight, falls back to `folder_id = null` and logs a warning with structured logger. Never fails generation.
- Extended `src/db/WorkflowRepository.js:createWorkflow` to persist `folder_id` and `user_id`.
- Added `TEST R4-46` in `tests/boundary/routeOwnershipAuditBoundary.test.js` to assert foreign refusal on `GET /api/projects/:projectId/assets`, keeping generic route completeness audit green.

## 2. Testing & Verification
- Dedicated Integration Suite: `tests/integration/generationWithFolder.test.js` (6 passing tests):
  - Scenario 8.1: image generation route creates workflow with specified folderId [VERIFIED]
  - Scenario 8.2: video generation route creates workflow with specified folderId [VERIFIED]
  - Scenario 8.3: upload route creates workflow with specified folderId [VERIFIED]
  - Scenario 8.4: generation refuses foreign or non-existent folderId with 404 before credit hold [VERIFIED]
  - Scenario 8.5: upload refuses foreign folderId with 404 [VERIFIED]
  - Scenario 8.6: worker falls back to folder_id null if folder is deleted while job is running [VERIFIED]
- Hermetic `npm test`: 638 passed, 9 failed (exact baseline failures: health redis readiness, v2 workflow run endpoints, model count clamping, rate limiting; 0 regressions) [VERIFIED].
- Code hygiene: 0 console.* added [VERIFIED]. Secrets scan clean [VERIFIED].
