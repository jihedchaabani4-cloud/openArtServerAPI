# PHASE-WM-GATE: Workflow Media Relation Gate Report

Phase: Phase WM (Workflow Media Relation)
Completed: 2026-10-08
Final Status: ALL TASKS DONE (WM-T1 through WM-T5)

## Summary (max 10 lines)
Phase WM successfully introduced `workflow_media` as an additive relation table linking `workflow` containers to `media` assets with semantic roles (`output`, `original`, `sheet`, `detail`, `reference`, `avatar`, `turnaround`).
Dual-writes are active across all creation paths, reads prioritize `workflow_media` with backward-compatible fallbacks, domain services (character, resolver) map roles canonically, and deletion enforces relation-unlinking and orphan checks so shared assets survive workflow deletions.
Legacy columns (`media.workflow_id`, `media.step_id`, `workflow.primary_media_id`) are preserved intact.

## Commit Chain
- `3c83431` — phaseWM(WM-T1): add workflow media relation foundation
- `55ac2c9` — phaseWM(WM-T2): dual-write workflow media links
- `07c5a67` — phaseWM(WM-T3): prefer workflow media reads
- `bc03041` — phaseWM(WM-T4): domain role migration for character and resolver
- `f8151bd` — phaseWM(WM-T5): orphan and shared media delete rules

## Test Results
- Full test suite: 685 tests, 676 pass, 9 fail
- Pre-existing failure baseline: exactly 9 tests (countBehavior, promptOptimization, uploadHardeningD25, v2WorkflowRun)
- New tests added across phase:
  - `tests/unit/workflowMediaMigrationSchema.test.js` (4 tests) — PASS
  - `tests/unit/workflowMediaRole.test.js` (3 tests) — PASS
  - `tests/unit/mediaServiceWorkflowMedia.test.js` (1 test) — PASS
  - `tests/unit/workflowMediaRoleResolution.test.js` (3 tests) — PASS
  - `tests/unit/workflowMediaDeleteOrphan.test.js` (4 tests) — PASS
- Net: +15 passing tests, 0 new failures introduced.

## Open Follow-ups
- [Low] ElementMediaService `resolveAsElement` returns all URLs without role-based split; future task can add role filter.
- [Low] WorkflowServiceBase pre-existing `console.warn` on lines 280/291/298 to be migrated to structured logger.

## Manual Checks for the Human
1. Apply migration on real database:
   ```bash
   psql $DATABASE_URL -f migrations/009_create_workflow_media.sql
   ```
2. Verify migration backfilled rows:
   ```sql
   SELECT count(*) FROM workflow_media;
   ```
3. Run test suite:
   ```bash
   npm test
   ```
