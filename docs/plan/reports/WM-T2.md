# WM-T2: Dual-Write New Media Relations
Status: DONE-WITH-FOLLOWUPS
Commit: this commit (not pushed)
Self-review score: 90/100 (loops: 1)
Baseline `npm test` before: FAIL (662 pass / 671 total / 9 known pre-existing failures)   After: FAIL (666 pass / 675 total / 9 known pre-existing failures)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED   `src/db/workflowMediaLinker.js` (shared fail-soft relation linker)
- EXTENDED  `controllers/imageController.js` (links generated image placeholders)
- EXTENDED  `controllers/videoController.js` (links generated video placeholders)
- EXTENDED  `src/db/workflowMediaOps.js` (links workflow/media create and append helpers; structured logger)
- EXTENDED  `src/platform/media/MediaService.js` (reuses shared linker)
- EXTENDED  `src/domain/character/CharacterGenerationService.js` (links sheet placeholder)
- EXTENDED  `src/domain/character/CharacterMediaService.js` (links sheet/detail rows and removes console usage in touched paths)
- EXTENDED  `src/domain/element/ElementMediaService.js` (links sheet/reference rows and removes console usage in touched paths)
- CREATED   `tests/unit/workflowMediaDualWritePaths.test.js`

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: `rg -n "db\.media\.createMedia|this\.db\.media\.createMedia" src controllers` found direct callers in image/video controllers, workflowMediaOps, MediaService, CharacterGenerationService, CharacterMediaService, and ElementMediaService.
- VERIFIED: `node --import ./tests/setup-env.js --test tests/unit/workflowMediaDualWritePaths.test.js tests/unit/mediaServiceWorkflowMedia.test.js` passed 5 tests.
- VERIFIED: `node --import ./tests/setup-env.js --test tests/integration/generationWithFolder.test.js tests/boundary/targetColumnsAndEntryPointWiringBoundary.test.js tests/boundary/mediaRatioAndDimensionPreservationBoundary.test.js` passed 23 tests.
- VERIFIED: full `npm test` was run and ended with 666 pass / 675 total / 9 fail, matching the known red baseline categories already present in this repo.
- VERIFIED: `rg -n "console\."` across touched WM-T2 source files printed no matches.
- VERIFIED: API response fields were not changed; dual-write calls happen after legacy media row creation.

## Tests
- New tests:
  - `links image and video generation placeholders to workflow_media`
  - `links character generation and character detail media to workflow_media`
  - `links element sheet and reference media to workflow_media`
  - `links workflowMediaOps create and append media to workflow_media`
- Failing-first confirmed: yes; the new test failed with zero link calls before implementation.
- Full npm test: FAIL with the repo's known pre-existing failures, not a new WM-T2-only regression.

## Decisions taken (refs to DECISIONS.md)
- INFERRED: kept relation writes fail-soft during rollout to preserve compatibility before all environments have migration 009.
- INFERRED: kept legacy `workflow_id` and `step_id` writes untouched.

## Follow-ups (also copied to BACKLOG.md)
- WM-T3 must make read paths prefer `workflow_media` while preserving legacy response fields.
- After migration 009 is deployed everywhere, decide whether link failures should remain warning-only.

## Manual checks for the human
- Apply migration 009 in Supabase before relying on persisted `workflow_media` rows in a real environment.
