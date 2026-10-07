# F-T2: Additive Database Migrations
Status: DONE
Commit: PENDING (phase3(F-T2))
Self-review score: 100/100 (loops: 1)
Baseline `npm test` before: FAIL (542 pass, 9 fail / 551 tests)   After: FAIL (552 pass, 9 fail / 561 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `migrations/008_create_folders_and_extend_workflow.sql` (additive PostgreSQL migration creating `folders`, extending `workflow` with `folder_id` composite FK and `user_id` backfill, with rollback comments)
- CREATED `tests/unit/folderMigrationSchema.test.js` (6 unit tests verifying table columns, composite constraints, NO ACTION foreign keys, idempotence, and additive-only rules)
- CREATED `tests/boundary/workflowOwnershipNullProject.test.js` (4 boundary tests verifying that workflows whose parent project has `user_id: null` reject foreign users like User B with HTTP 404)

## Handling of Workflows with project.user_id NULL
- During backfill: `UPDATE workflow w SET user_id = p.user_id FROM projects p WHERE w.project_id = p.id AND w.user_id IS NULL;` leaves `workflow.user_id` as `NULL` if `project.user_id` is `NULL`.
- Security enforcement: In `src/platform/security/ownership.js:assertOwns("workflow", id, userId)`:
  - Direct check `wfRecord.user_id === userId` evaluates to falsy (`null === userId`).
  - Project check `db.projects.findByUser(userId, wfRecord.project_id)` queries projects owned by `userId`. Because `project.user_id` is NULL, `findByUser` returns an empty array `[]`.
  - `resource` remains `null`, logging `ownership.denied` and throwing `AppError("Workflow not found", 404)`.
  - User B (and all other users) receive HTTP 404 and never obtain access to the workflow.

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --import ./tests/setup-env.js --test "tests/unit/folderMigrationSchema.test.js"` failed 6/6 with `ENOENT` prior to creating migration file.
- VERIFIED: schema tests passing — 6/6 tests passing in `tests/unit/folderMigrationSchema.test.js`.
- VERIFIED: null project user_id boundary tests passing — 4/4 tests passing in `tests/boundary/workflowOwnershipNullProject.test.js` proving User B receives 404.
- VERIFIED: additive-only validation — `rg -n -i "drop|rename|alter column" migrations/008_create_folders_and_extend_workflow.sql` returned hits only inside rollback comments (lines 20-26); active SQL contains zero destructive statements.
- VERIFIED: full hermetic `npm test` before commit — 552 pass, 9 pre-existing fail across 561 tests (0 regressions).
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits.
- NOT-RUN: Applying migration to live/staging database (`psql $DATABASE_URL -f migrations/008_create_folders_and_extend_workflow.sql`). Per contract, migrations are never applied to a real DB during development.
- NOT-RUN: Real database behavior for schema verification. Unit tests only parse and validate `.sql` syntax and structural constraints statically; live PostgreSQL execution requires staging environment deployment.
