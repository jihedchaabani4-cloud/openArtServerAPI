# F-T3: FolderRepository (User & Project Scoped Data Access)
Status: DONE
Commit: caf53ff (not pushed)
Self-review score: 100/100 (loops: 1)
Baseline `npm test` before: FAIL (554 pass, 9 fail / 563 tests)   After: FAIL (570 pass, 9 fail / 579 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `src/db/FolderRepository.js` (strictly scoped data access layer: listByProject, findOwned, findOwnedInProject, countByProject, create, updateOwned, deleteOwned, countAssetsByFolder, countChildren, countAssetsIn; explicitly blocks unscoped methods)
- CREATED `tests/integration/folderRepository.test.js` (16 unit/integration tests verifying multi-tenant isolation, owner operations, unscoped blocking, and counting helpers)
- EXTENDED `src/container.js` (wired `FolderRepository` into container `db.folders`)

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --import ./tests/setup-env.js --test "tests/integration/folderRepository.test.js"` failed with `ERR_MODULE_NOT_FOUND`
- VERIFIED: repository tests passing — 16/16 tests passing in `tests/integration/folderRepository.test.js`
- VERIFIED: multi-tenant isolation — User B cannot find, update, or delete User A's folder
- VERIFIED: unscoped methods blocked — calling `findById`, `deleteById`, `delete` on `FolderRepository` throws an explicit Error
- VERIFIED: full hermetic `npm test` before commit — 570 pass, 9 pre-existing fail across 579 tests in 108 suites (0 regressions)
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits
- VERIFIED: zero `console.*` calls in `src/db/FolderRepository.js`
