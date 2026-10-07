# F-T6: Move Asset to Folder (Dedicated Route) & Mass-Assignment Guard
Status: DONE
Commit: bd16fd8 (not pushed)
Self-review score: 100/100 (loops: 1)
Baseline `npm test` before: FAIL (604 pass, 9 fail / 614 tests)   After: FAIL (618 pass, 9 fail / 627 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `src/domain/assetDto.js` (`toAssetDto(workflow)` serializer mapping workflow row to product asset JSON)
- EXTENDED `src/db/WorkflowRepository.js` (added `updateFolderId(workflowId, folderId, userId)` scoped by tenant)
- EXTENDED `routes/assets.js` (implemented `PATCH /:assetId/folder` with `assertOwns("workflow")` and `folderService.assertFolderUsable`)
- EXTENDED `controllers/workflowsController.js` (added mass-assignment defense in `patchWorkflow` rejecting `folderId`, `folder_id`, `projectId`, `project_id`, `userId`, `user_id` with 400)
- EXTENDED `tests/boundary/routeOwnershipAuditBoundary.test.js` (added `TEST R4-45` for `PATCH /api/assets/:assetId/folder` foreign refusal and registered route in `explicitRefusalRoutes`)
- CREATED `tests/integration/assetFolderMove.test.js` (13 tests covering Scenario 8: move to folder, move to root, move with folderId='none', foreign folder 404, cross-project folder 404, foreign asset 404, unauthenticated 401, internal secret exclusion, and generic workflow update mass-assignment rejection)

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --test tests/integration/assetFolderMove.test.js` failed initially (5 passed, 8 failed)
- VERIFIED: asset move tests passing — 13/13 tests passing in `tests/integration/assetFolderMove.test.js`
- VERIFIED: boundary audit passing — 47/47 tests passing in `tests/boundary/routeOwnershipAuditBoundary.test.js`
- VERIFIED: full hermetic `npm test` before commit — 618 pass, 9 pre-existing fail across 627 tests in 130 suites (0 regressions)
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits
- VERIFIED: zero `console.*` calls in touched code
- NOT-RUN: real DB / staging migration application (strictly prohibited by rule)
