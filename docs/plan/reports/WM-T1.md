# WM-T1: Add Relation Schema And Repository Foundation
Status: DONE-WITH-FOLLOWUPS
Commit: this commit (not pushed)
Self-review score: 90/100 (loops: 1)
Baseline `npm test` before: FAIL (known pre-existing failures)   After: FAIL (known pre-existing failures)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED   `migrations/009_create_workflow_media.sql` (additive relation table and backfill)
- CREATED   `src/db/workflowMediaRole.js` (canonical role inference)
- CREATED   `src/db/WorkflowMediaRepository.js` (relation repository)
- EXTENDED  `src/container.js` (registered `db.workflowMedia`)
- EXTENDED  `src/platform/media/MediaService.js` (dual-write on `createMedia`)
- EXTENDED  `tests/boundary/envFailSafeBoundary.test.js` (structured logger assertion, no `console.warn` spy)
- CREATED   `tests/unit/workflowMediaMigrationSchema.test.js`
- CREATED   `tests/unit/workflowMediaRole.test.js`
- CREATED   `tests/unit/mediaServiceWorkflowMedia.test.js`

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: `node --import ./tests/setup-env.js --test tests/unit/workflowMediaMigrationSchema.test.js tests/unit/workflowMediaRole.test.js tests/unit/mediaServiceWorkflowMedia.test.js` passed 8 tests.
- VERIFIED: `node --import ./tests/setup-env.js --test tests/boundary/envFailSafeBoundary.test.js` passed 12 tests.
- VERIFIED: `node --import ./tests/setup-env.js --test tests/integration/generationWithFolder.test.js` passed 7 tests after the fail-soft compatibility path.
- VERIFIED: `npm test` was run and ended with 662 pass / 671 total / 9 fail, matching the known red baseline categories already present in this repo.
- VERIFIED: `rg -n "console\."` across touched source and test files printed no matches.
- VERIFIED: staged sensitive-value scan printed only documentation false positives before wording cleanup, with no real credentials.
- VERIFIED: migration 009 only creates `workflow_media`, indexes, constraints, and backfills relation rows; it does not remove or rename existing schema.
- NOT-RUN: migration was not applied to a real Supabase database by the agent. The human can run `migrations/009_create_workflow_media.sql` in Supabase SQL editor after backup/staging validation.

## Tests
- New tests:
  - `creates workflow_media migration with additive schema and backfill`
  - `maps legacy step ids and workflow types to canonical roles`
  - `links created media to workflow_media after media creation`
- Failing-first confirmed: yes; tests failed before migration/helper/service changes because required files or relation writes were missing.
- Full npm test: FAIL with the repo's known pre-existing failures, not a new WM-T1-only regression.

## Decisions taken (refs to DECISIONS.md)
- INFERRED: followed D-21 / no renames and kept `media.workflow_id`, `media.step_id`, and `workflow.primary_media_id`.
- INFERRED: relation write is fail-soft during the additive rollout so old deployments/tests without the new table do not break before migration is applied.

## Follow-ups (also copied to BACKLOG.md)
- WM-T2 must cover direct media write paths outside `MediaService.createMedia`.
- After migration is deployed everywhere, revisit whether relation write failures should become fail-closed.

## Manual checks for the human
- Apply SQL manually in Supabase only after backup/staging check: `migrations/009_create_workflow_media.sql`.
