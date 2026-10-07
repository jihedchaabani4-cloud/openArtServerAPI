# F-T5: Folder REST Routes & Controller
Status: DONE
Commit: d9f6597 (not pushed)
Self-review score: 95/100 (loops: 1)
Baseline `npm test` before: FAIL (585 pass, 9 fail / 594 tests)   After: FAIL (604 pass, 9 fail / 614 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `controllers/foldersController.js` (listProjectFolders, createProjectFolder, updateFolder, deleteFolder with assertOwns checks)
- CREATED `routes/folders.js` (PATCH /:folderId, DELETE /:folderId mounted with requireAuth and rateLimit)
- EXTENDED `routes/projects.js` (GET /:projectId/folders, POST /:projectId/folders mounted with requireAuth and rateLimit)
- EXTENDED `src/api/routes.js` (mounted `/folders` router)
- EXTENDED `src/config/rateLimitPolicies.js` (added `folderWrite` policy: 60 req/min per user)
- EXTENDED `src/platform/security/ownership.js` (added `case "folder"` in assertOwns verifying findOwned and project ownership)
- EXTENDED `tests/boundary/routeOwnershipAuditBoundary.test.js` (added R4-41..R4-44 foreign refusal tests and registered folder routes in explicitRefusalRoutes)
- CREATED `tests/integration/folderRoutes.test.js` (15 tests covering Acceptance Scenarios 1-6 & 10, unauthenticated 401, internal secret exclusion, cross-tenant 404, rate limiting 429)

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --test tests/integration/folderRoutes.test.js` failed initially on missing controller/routes
- VERIFIED: folder route tests passing — 15/15 tests passing in `tests/integration/folderRoutes.test.js`
- VERIFIED: boundary audit passing — 46/46 tests passing in `tests/boundary/routeOwnershipAuditBoundary.test.js`
- VERIFIED: full hermetic `npm test` before commit — 604 pass, 9 pre-existing fail across 614 tests in 127 suites (0 regressions)
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits
- VERIFIED: zero `console.*` calls in touched code
- NOT-RUN: real DB / staging migration application (strictly prohibited by rule)
