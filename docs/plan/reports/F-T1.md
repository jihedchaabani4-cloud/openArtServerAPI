# F-T1: Pure Tree Module + Unit Tests
Status: DONE
Commit: PENDING (phase3(F-T1))
Self-review score: 100/100 (loops: 1)
Baseline `npm test` before: FAIL (517 pass, 9 fail / 526 tests)   After: FAIL (542 pass, 9 fail / 551 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `src/domain/folderTree.js` (pure hierarchy calculation functions: indexById, indexChildren, getAncestorIds, getDepth, getSubtreeHeight, collectDescendantIds, wouldCreateCycle, wouldExceedDepth, depthForNewChild)
- CREATED `tests/unit/folderTree.test.js` (25 unit tests covering all 7.4 test vectors and cycle protections)
- EXTENDED `docs/plan/BACKLOG.md` (added High priority item for ProjectReadService.js:62 permissive check on user_id NULL)

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --import ./tests/setup-env.js --test "tests/unit/folderTree.test.js"` failed with `ERR_MODULE_NOT_FOUND`
- VERIFIED: unit tests passing — 25 passing tests in `tests/unit/folderTree.test.js`
- VERIFIED: full hermetic `npm test` before commit — 542 pass, 9 pre-existing fail (551 total tests, 0 regressions)
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits
- VERIFIED: zero `console.*` calls in `src/domain/folderTree.js` (`rg -n "console\." src/domain/folderTree.js` returned 0 hits)
- VERIFIED: zero framework or database imports in `src/domain/folderTree.js` (100% pure JavaScript)
