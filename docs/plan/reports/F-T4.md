# F-T4: FolderService (Business Logic & Validation Rules)
Status: DONE
Commit: ade01fb (not pushed)
Self-review score: 100/100 (loops: 1)
Baseline `npm test` before: FAIL (570 pass, 9 fail / 579 tests)   After: FAIL (585 pass, 9 fail / 594 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `src/domain/folder/FolderService.js` (business logic service: list, create, update, remove, assertFolderUsable; sibling uniqueness, cycle detection, depth limits, empty folder deletion)
- CREATED `tests/unit/folderService.test.js` (15 unit tests covering all error table codes: FOLDER_NAME_INVALID, FOLDER_NAME_TAKEN, FOLDER_CYCLE, FOLDER_DEPTH_EXCEEDED, FOLDER_LIMIT_REACHED, FOLDER_NOT_EMPTY, NOT_FOUND, plus happy paths)
- EXTENDED `src/container.js` (wired `folderService` with `db.folders`)
- EXTENDED `src/domain/folderTree.js` (supported both `parentId` and `parent_id` keys in tree indexing and ancestor traversal)

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --import ./tests/setup-env.js --test "tests/unit/folderService.test.js"` failed with `ERR_MODULE_NOT_FOUND`
- VERIFIED: service unit tests passing — 15/15 tests passing in `tests/unit/folderService.test.js`
- VERIFIED: all 7 error table scenarios verified by unit tests (FOLDER_NAME_INVALID, FOLDER_NAME_TAKEN, FOLDER_CYCLE, FOLDER_DEPTH_EXCEEDED, FOLDER_LIMIT_REACHED, FOLDER_NOT_EMPTY, NOT_FOUND)
- VERIFIED: full hermetic `npm test` before commit — 585 pass, 9 pre-existing fail across 594 tests in 109 suites (0 regressions)
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits
- VERIFIED: zero `console.*` calls in `src/domain/folder/FolderService.js`
