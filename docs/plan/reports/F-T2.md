# F-T2: Additive Database Migrations (Schema Hardened)
Status: DONE
Commit: PENDING (phase3(F-T2-fix))
Self-review score: 100/100 (loops: 2)
Baseline `npm test` before: FAIL (542 pass, 9 fail / 551 tests)   After: FAIL (554 pass, 9 fail / 563 tests)

## What changed (REUSED / EXTENDED / CREATED)
- CREATED `migrations/008_create_folders_and_extend_workflow.sql` (additive PostgreSQL migration creating `folders` with RLS and `position`, extending `workflow` with `folder_id` composite FK and `user_id` backfill using real schema names `project` and `create_time`)
- CREATED `tests/unit/folderMigrationSchema.test.js` (8 unit tests cross-referencing `database_schema.sql` to verify table names, column names, NO ACTION foreign keys, RLS policies, and additive-only rules)
- CREATED `tests/boundary/workflowOwnershipNullProject.test.js` (4 boundary tests verifying that workflows whose parent project has `user_id: null` reject foreign users like User B with HTTP 404)

## Cross-Check Against database_schema.sql
| Entity / Symbol in 008 | Type / Role | Location in database_schema.sql | Proof / Notes |
|---|---|---|---|
| `public.project` | Referenced Table | `database_schema.sql:72` | `CREATE TABLE public.project` (singular, not `projects`) |
| `project.id` | Referenced Column / PK | `database_schema.sql:73` | `id uuid NOT NULL DEFAULT gen_random_uuid()` |
| `project.user_id` | Referenced Column | `database_schema.sql:76` | `user_id uuid` |
| `public.workflow` | Extended Table | `database_schema.sql:111` | `CREATE TABLE public.workflow` |
| `workflow.id` | Workflow PK | `database_schema.sql:112` | `id uuid NOT NULL DEFAULT gen_random_uuid()` |
| `workflow.project_id` | Foreign Key Column | `database_schema.sql:113` | `project_id uuid NOT NULL` (already NOT NULL, making extra check redundant) |
| `workflow.create_time` | Timestamp Column | `database_schema.sql:118` | `create_time timestamp with time zone NOT NULL DEFAULT now()` (not `created_at`) |
| `folders.position` | Position Column | Plan required | `04_P3_folders.md:139, 242-244` (used for folder reordering and sibling indexing) |
| `folders` RLS | Security Policy | `database_schema.sql:484-497` | Repo enforces RLS on public tables; added `folders_owner` policy (`user_id = auth.uid()`) |

## Handling of Workflows with project.user_id NULL
- During backfill: `UPDATE workflow w SET user_id = p.user_id FROM public.project p WHERE w.project_id = p.id AND w.user_id IS NULL;` leaves `workflow.user_id` as `NULL` if `project.user_id` is `NULL`.
- Security enforcement: In `src/platform/security/ownership.js:assertOwns("workflow", id, userId)`:
  - Direct check `wfRecord.user_id === userId` evaluates to falsy (`null === userId`).
  - Project check `db.projects.findByUser(userId, wfRecord.project_id)` queries projects owned by `userId`. Because `project.user_id` is NULL, `findByUser` returns an empty array `[]`.
  - `resource` remains `null`, logging `ownership.denied` and throwing `AppError("Workflow not found", 404)`.
  - User B (and all other users) receive HTTP 404 and never obtain access to the workflow.

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: failing test first — `node --import ./tests/setup-env.js --test "tests/unit/folderMigrationSchema.test.js"` failed 4/8 against unhardened 008 migration (`projects`, `created_at`, redundant constraint, missing RLS).
- VERIFIED: schema tests passing — 8/8 tests passing in `tests/unit/folderMigrationSchema.test.js` after fix.
- VERIFIED: null project user_id boundary tests passing — 4/4 tests passing in `tests/boundary/workflowOwnershipNullProject.test.js` proving User B receives 404.
- VERIFIED: additive-only validation — `rg -n -i "drop|rename|alter column" migrations/008_create_folders_and_extend_workflow.sql` returned hits only inside rollback comments (lines 20-27); active SQL contains zero destructive statements.
- VERIFIED: full hermetic `npm test` before commit — 554 pass, 9 pre-existing fail across 563 tests in 107 suites (0 regressions).
- VERIFIED: secrets scan on `git diff --cached` returned 0 hits.
- NOT-RUN: Applying migration to live/staging database (`psql $DATABASE_URL -f migrations/008_create_folders_and_extend_workflow.sql`). Per contract, migrations are never applied to a real DB during development.
- NOT-RUN: Real database behavior for schema verification. Unit tests only parse and validate `.sql` syntax and structural constraints statically; live PostgreSQL execution requires staging environment deployment.
