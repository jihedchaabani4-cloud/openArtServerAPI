# PREP-P3 Report: Folders Feature Preparation

**Feature Directory**: `specs/034-p3-folders/`
**Status**: PREP Completed, waiting for `GO` from human
**Date**: 2026-10-07

---

## 1. Core Plan Questions Answered

### (1) Whether Path A is consistent with `workflow` having no `user_id`
**Yes, Path A is completely consistent.** Section 7.3 explicitly foresaw this exact finding from SES0 and specified the exact additive approach:
> "Direct user_id on the existing Asset table (probably workflow). If SES0 shows that table has no user_id: add user_id uuid null in one migration, backfill from the project owner in a separate idempotent migration, and verify the backfill (count of rows where user_id is null must be 0) before any code relies on it. Enforcing NOT NULL is a LATER migration, not part of this phase (record it in BACKLOG.md). Reason: keeps rollback safe."
- Under Path A, `public.workflow` is the existing asset-level table that receives `folder_id` and the composite foreign key `(folder_id, project_id) REFERENCES public.folders(id, project_id)`.
- The absence of `user_id` on `workflow` today does not conflict with Path A; task F-T2 will add a nullable `user_id` column to `workflow`, backfill it from `public.project.user_id`, and verify the backfill before downstream tasks rely on it.

### (2) How the plan handles projects with `user_id NULL`
- **Database Schema**: `public.project.user_id` is nullable in `database_schema.sql:76`.
- **Security Scoping (`assertOwns`)**: In `src/platform/security/ownership.js:35-43`, ownership verification enforces `record && record.user_id === userId`. If a project has `user_id NULL`, it fails ownership for all authenticated users and returns HTTP 404 (`Project not found`).
- **Folder Creation**: `public.folders.user_id` is defined as `UUID NOT NULL` (`04_P3_folders.md` line 128). It is always populated on the server from the authenticated session (`req.user.id`), never from client input.
- **Backfill Handling**: Workflows associated with legacy or orphan test projects where `user_id IS NULL` will remain NULL until assigned. No authenticated client can access those projects or workflows because all project-scoped routes require `assertOwns("project", projectId, userId)`.

### (3) Conflicts between new routes and existing `/api/assets/*` and `/api/workflows/workflows/:id/move`
- **Existing `/api/assets/*`**:
  - Existing endpoints in `routes/assets.js` are `POST /api/assets/upload` and `DELETE /api/assets/:id` (media deletion).
  - New asset listing `GET /api/projects/:projectId/assets` is mounted under `/api/projects/`, avoiding any path collision with `/api/assets`.
  - New dedicated asset move route `PATCH /api/assets/:assetId/folder` adds a distinct HTTP method and subpath (`PATCH` on `/:assetId/folder`), with zero collision against `POST /upload` or `DELETE /:id`.
- **Existing `/api/workflows/workflows/:id/move`**:
  - Handles legacy session/project moves (`{ session_id, project_id, newsession, session_name }`).
  - Does NOT handle folders; the new dedicated route `PATCH /api/assets/:assetId/folder` handles folder moves exclusively.
  - Per section 7.6 rule 9, `PATCH /api/workflows/workflows/:id` will be guarded to ignore/reject `folderId`, `folder_id`, `projectId`, `project_id`, `userId`, `user_id` in the body, ensuring mass-assignment protection.

---

## 2. Generated Spec Kit Artifacts

All Spec Kit artifacts generated under `specs/034-p3-folders/`:
1. `specs/034-p3-folders/spec.md`:
   - Contains sections 7.1 to 7.7 verbatim, user stories 1–8 with acceptance scenarios 1–10, requirements FR-001 through FR-006, and Decisions D-01 through D-25.
2. `specs/034-p3-folders/plan.md`:
   - Full technical architecture, Path A additive schema definitions, pure tree module architecture, component layout, and verification strategy.
3. `specs/034-p3-folders/tasks.md`:
   - Strict 1:1 mapping with tasks F-T1 through F-T9 from section 7.8, with explicit "write failing test first" sub-tasks for each code change.
4. `.specify/feature.json`:
   - Updated to point to `specs/034-p3-folders`.

---

## 3. Task List Mapping & Comparison

| Spec Kit Task | Phase File Task | Description | Failing Test First? |
|---|---|---|---|
| F-T1 | F-T1 | Pure tree module (`folderTree.js`) and test vectors | Yes (`tests/unit/folderTree.test.js`) |
| F-T2 | F-T2 | Additive migrations (`folders`, `workflow.folder_id`, `workflow.user_id`) | Yes (schema assertion test) |
| F-T3 | F-T3 | `FolderRepository` (user & project scoped queries) | Yes (`tests/integration/folderRepository.test.js`) |
| F-T4 | F-T4 | `FolderService` (business rules, error table codes) | Yes (`tests/unit/folderService.test.js`) |
| F-T5 | F-T5 | Folder REST routes & controller (`GET/POST /projects/:id/folders`, `PATCH/DELETE /folders/:id`) | Yes (`tests/integration/folderRoutes.test.js`) |
| F-T6 | F-T6 | Dedicated asset move `PATCH /api/assets/:assetId/folder` + mass-assignment guard | Yes (`tests/integration/assetFolderMove.test.js`) |
| F-T7 | F-T7 | Asset listing with folder filters & cursor pagination (`GET /projects/:id/assets`) | Yes (`tests/integration/assetListingWithFolders.test.js`) |
| F-T8 | F-T8 | Target `folderId` on generate/upload + worker fallback | Yes (`tests/integration/generationWithFolder.test.js`) |
| F-T9 | F-T9 | Documentation, frontend handoff (`frontend-changes-needed.md`), regressions, gate | Yes (regression checks) |

**Differences Found**: None. `tasks.md` was verified to match F-T1 through F-T9 1:1.

---

## 4. Open Assumptions

- No external dependencies required.
- Migrations will be prepared in `migrations/` and verified additively without running on a live external database during testing.
