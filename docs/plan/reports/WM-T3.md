# WM-T3: Compatibility Reads
Status: DONE-WITH-FOLLOWUPS
Commit: this commit (not pushed)
Self-review score: 90/100 (loops: 1)
Baseline `npm test` before: FAIL (666 pass / 675 total / 9 known pre-existing failures)   After: FAIL (669 pass / 678 total / 9 known pre-existing failures)

## What changed (REUSED / EXTENDED / CREATED)
- EXTENDED  `src/db/MediaRepository.js` (findByWorkflow prefers relation rows and falls back to legacy rows)
- EXTENDED  `src/db/WorkflowRepository.js` (primary media fallback checks relation rows before legacy media.workflow_id)
- EXTENDED  `src/domain/project/ProjectReadService.js` (adds role/mediaRole from workflow_media when available)
- CREATED   `tests/unit/workflowMediaCompatibilityReads.test.js`

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: `node --import ./tests/setup-env.js --test tests/unit/workflowMediaCompatibilityReads.test.js` passed 3 tests.
- VERIFIED: `node --import ./tests/setup-env.js --test tests/unit/workflowMediaCompatibilityReads.test.js tests/boundary/referenceAndMediaOwnershipBoundary.test.js tests/boundary/useCaseWorkflowAndSettlementBoundary.test.js tests/boundary/mediaPersistenceFailureBoundary.test.js tests/boundary/targetColumnsAndEntryPointWiringBoundary.test.js` passed 31 tests.
- VERIFIED: full `npm test` was run and ended with 669 pass / 678 total / 9 fail, matching the known red baseline categories already present in this repo.
- VERIFIED: `rg -n "console\." src/db/MediaRepository.js src/db/WorkflowRepository.js src/domain/project/ProjectReadService.js tests/unit/workflowMediaCompatibilityReads.test.js` printed no matches.
- VERIFIED: `MediaRepository.findByWorkflow` preserves `workflow_id`, `workflowId`, `role`, and `mediaRole` for relation rows.

## Tests
- New tests:
  - `MediaRepository.findByWorkflow prefers workflow_media rows and preserves legacy response fields`
  - `MediaRepository.findByWorkflow falls back to legacy media.workflow_id rows`
  - `WorkflowRepository.getPrimaryMedia falls back to workflow_media before legacy media.workflow_id`
- Failing-first confirmed: yes; the new test failed while reads were legacy-only.
- Full npm test: FAIL with the repo's known pre-existing failures, not a new WM-T3-only regression.

## Decisions taken (refs to DECISIONS.md)
- INFERRED: if `workflow_media` is missing or empty, read paths stay backward compatible with legacy `media.workflow_id`.
- INFERRED: project data keeps existing response fields and only adds `role` / `mediaRole`.

## Follow-ups (also copied to BACKLOG.md)
- WM-T4 must migrate character/element/reference resolution to prefer role fields while retaining `step_id` compatibility.

## Manual checks for the human
- After applying migration 009, inspect one real project response and confirm `media[].mediaRole` appears on new relation rows.
