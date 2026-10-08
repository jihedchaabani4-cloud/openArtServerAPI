# WM-T5: Delete And Orphan Rules
Status: DONE
Commit: (see below)
Self-review score: 98/100 (loops: 1)
Baseline `npm test` before: FAIL (9 pre-existing, 672/681 pass)   After: FAIL (9 pre-existing, 676/685 pass — +4 passing tests, 0 new failures)

## What changed (REUSED / EXTENDED / CREATED)

- EXTENDED  `src/platform/workflow/WorkflowMediaService.js`  
  — `deleteMedia`: added step 1 `db.workflowMedia.unlink({ mediaId })` before deleting the media record.  
  — Step 3: orphan check via `db.workflowMedia.countLinksForMedia(mediaId)` — only deletes the physical storage file if remaining link count is 0 (orphaned). Shared media files survive.  
  — Migrated all `console.warn` and `console.log` calls to structured `logger.warn`.
- CREATED   `tests/unit/workflowMediaDeleteOrphan.test.js`  
  — 4 tests: orphan storage deletion, shared media storage preservation, cross-tenant 404 rejection, unlink-before-delete ordering guarantee.

## Evidence

- VERIFIED: `node --test tests/unit/workflowMediaDeleteOrphan.test.js` → 4/4 pass.
- VERIFIED: `npm test` → 685 tests, 676 pass, 9 fail — identical failure baseline, 4 new passing tests.
- VERIFIED: `git diff --cached | rg -i "(secret|token|apikey|...)"` → empty output.
- VERIFIED: `rg -n "console\." src/platform/workflow/WorkflowMediaService.js` → 0 hits.
- INFERRED: deleting a shared media row when one workflow is deleted preserves the file for all other workflows linking to it.

## Tests

- New tests:
  1. `unlinks workflow_media relation before deleting media row (orphaned media — 0 links)`
  2. `does NOT delete storage file when media still has relation links (shared media)`
  3. `returns 404 (throws CrudServiceError) when media belongs to another user`
  4. `unlink is called before deleteById (ordering guarantee)`
- Failing-first confirmed: yes, 3 failed before fix (orphan logic + unlink did not exist).
- Full npm test: FAIL (9 pre-existing failures, 0 new).

## Self-review findings

- PASS — Security: verifyMediaOwnership rejects foreign users with 404
- PASS — Correctness: storage only deleted for true orphans; unlink precedes record deletion
- PASS — Operability: structured logger only, no console.*
- PASS — Tests: hermetic, unit-level, spy-based
- PASS — Additive: backward compatible with workflows not using workflow_media (fallbacks to count=0)
