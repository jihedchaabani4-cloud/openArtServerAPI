# Phase WM: Workflow Media Relation

## Goal

Introduce `workflow_media` as the additive relation table between the existing
`workflow` container and reusable `media` files.

This phase keeps legacy columns alive:

- `media.workflow_id`
- `media.step_id`
- `workflow.primary_media_id`

No table, column, route, class, or public response shape is renamed or removed.

## Decisions

- `workflow` remains the product asset/container table.
- `media` remains the file/output table.
- `workflow_media` stores relation semantics with `role`.
- No history tree is added. Generation lineage remains in
  `generation_config_reference`.
- `workflow.primary_media_id` remains the single current/selected media pointer.
- Frontend compatibility fields stay in API responses until a later cleanup.

## Role Vocabulary

- `output`
- `original`
- `sheet`
- `detail`
- `reference`
- `avatar`
- `turnaround`

## Task Checklist

| Task | Status | Commit | Report |
|---|---|---|---|
| WM-T1 Add relation schema and repository foundation | DONE | this commit | `docs/plan/reports/WM-T1.md` |
| WM-T2 Dual-write new media relations | TODO | | |
| WM-T3 Compatibility reads | TODO | | |
| WM-T4 Domain role migration | TODO | | |
| WM-T5 Delete and orphan rules | TODO | | |
| WM-GATE Phase gate | TODO | | |

Rules for future agents:

- Mark a task `DONE` only after its tests and report exist.
- Put the commit short SHA in the table after committing.
- Do not start trash/corbeille, frontend, folders, or hard-delete work in this phase.
- Do not remove `media.workflow_id`, `media.step_id`, or `workflow.primary_media_id`.

## Task WM-T1: Add Relation Schema And Repository Foundation

Status: DONE

Files:

- `migrations/009_create_workflow_media.sql`
- `src/db/WorkflowMediaRepository.js`
- `src/db/workflowMediaRole.js`
- `src/container.js`
- `tests/unit/workflowMediaMigrationSchema.test.js`
- `tests/unit/workflowMediaRole.test.js`

Steps:

1. Write failing schema/role tests first.
2. Add additive migration 009.
3. Add role inference helper.
4. Add `WorkflowMediaRepository`.
5. Register repository in `db.workflowMedia`.
6. Run the new tests, then full `npm test`.

Acceptance:

- [x] Migration is additive and idempotent.
- [x] Migration creates `workflow_media` with explicit constraints and indexes.
- [x] Migration backfills from `media.workflow_id` and `media.step_id`.
- [x] Role helper maps all legacy `step_id` values to canonical roles.
- [x] Repository registered as `db.workflowMedia`.
- [x] Existing dirty files outside this task are not touched.

## Task WM-T2: Dual-Write New Media Relations

Status: TODO

Files:

- `src/platform/media/MediaService.js`
- `src/platform/media-ingestion/MediaIngestionService.js`
- generation placeholder creation paths that call `db.media.createMedia` directly

Steps:

1. Add tests proving new generated, upload, character, and element media writes
   create `workflow_media` rows.
2. Add helper calls after media creation.
3. Preserve legacy `workflow_id` and `step_id` writes.

Acceptance:

- [ ] Search every `db.media.createMedia` caller and list it in the task report.
- [ ] New media rows keep old fields and also get a relation row.
- [ ] Generated media writes create `workflow_media` rows.
- [ ] Upload media writes create `workflow_media` rows.
- [ ] Character media writes create `workflow_media` rows.
- [ ] Element media writes create `workflow_media` rows.
- [ ] No frontend/API response shape changes.

## Task WM-T3: Compatibility Reads

Status: TODO

Files:

- `src/db/MediaRepository.js`
- `src/db/WorkflowRepository.js`
- `src/domain/project/ProjectReadService.js`

Steps:

1. Make `findByWorkflow` prefer `workflow_media`.
2. Preserve returned legacy fields: `workflow_id`, `workflowId`, `step_id`,
   `workflowStepId`.
3. Add `role` and `mediaRole` to formatted media.
4. Keep fallback to `media.workflow_id` for pre-migration rows.

Acceptance:

- [ ] Old frontend continues to work.
- [ ] New role information is available.
- [ ] Primary media fallback uses relation rows before legacy rows.
- [ ] Legacy rows without `workflow_media` still appear via fallback.

## Task WM-T4: Domain Role Migration

Status: TODO

Files:

- `src/domain/character/CharacterMediaService.js`
- `src/domain/element/ElementMediaService.js`
- `src/v2/resolvers/WorkflowReferenceResolver.js`

Steps:

1. Replace direct `step_id` role checks with `role || step_id` compatibility.
2. Keep old `step_id` support.
3. Add tests for sheet/detail/reference resolution.

Acceptance:

- [ ] Character sheet/detail resolution works via roles.
- [ ] Element sheet/reference resolution works via roles.
- [ ] Legacy rows still work.
- [ ] No role logic is duplicated between domain services.

## Task WM-T5: Delete And Orphan Rules

Status: TODO

Files:

- `src/platform/workflow/WorkflowMediaService.js`
- `src/platform/security/ownership.js`

Steps:

1. Delete relation first, then delete media only if orphaned.
2. Treat shared media as reusable and never delete its file while still linked.
3. Ownership-check media through relation rows when legacy `workflow_id` is not
   enough.

Acceptance:

- [ ] Shared media survives deleting one workflow relation.
- [ ] Cross-tenant media access remains 404.
- [ ] Physical file deletion happens only for true orphans.
- [ ] Relation delete happens before true orphan cleanup.

## Phase Gate

- [ ] New tests pass.
- [ ] Full `npm test` is run and reported.
- [ ] Sensitive-value scan on staged diff prints no real credentials.
- [ ] Migration was not applied to a real database.
- [ ] Task checklist above has commit SHAs for completed tasks.
