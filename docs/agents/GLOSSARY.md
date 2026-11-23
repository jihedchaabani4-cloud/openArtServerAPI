# GLOSSARY.md — Canonical Domain & Architectural Vocabulary (`apiOpenArt`)

> **Canonical Location:** `docs/agents/GLOSSARY.md`  
> This glossary defines the authoritative domain and architectural terminology across all 8 Business Systems in `apiOpenArt`.

---

## 1. Architectural Concepts

### Business System
A self-contained black-box module located in `src/systems/<system>/` (`generation`, `models`, `billing`, `media`, `identity`, `characters`, `elements`, `workspace`). Exposes functionality exclusively via `public/api.js` (HTTP Web Gateway) and `public/tools.js` (System Tools Interface). All implementation details live strictly inside `internal/`.

### Web Gateway (`public/api.js`)
An Express router exposing HTTP endpoints (`req, res`) mounted by the Main Router (`src/api/routes.js`). Responsible for route definitions, attaching auth/rate-limit/upload middlewares, and delegating to `internal/controllers/`.

### Tools Interface (`public/tools.js`)
The contract of async functions and DTO factories exposed to other Business Systems, background workers, and `src/container.js` via `#<system>/tools`.

### Internal Boundary (`internal/`)
Strictly private controllers (`internal/controllers/`), services (`internal/services/`), database repositories (`internal/db/`), and domain errors (`internal/errors.js`) of a Business System. External files are forbidden from importing anything inside `internal/` (`Rule R10`).

### Shared Technical Kernel (`src/shared/` / `#shared`)
Pure technical utilities with zero domain business logic: validated environment config (`src/shared/config/env.js`), raw Supabase factory (`src/shared/db/supabase.js`), base error classes (`src/shared/errors/AppError.js`), structured Pino logging (`src/shared/logger/index.js`), and Redis connections (`src/shared/redis/index.js`).

### Main API Router (`src/api/routes.js`)
The single HTTP entry point mounting all 8 `#<system>/api` routers plus health/readiness probes (`src/api/probes/health.js`, `src/api/probes/ready.js`).

---

## 2. Domain & Operational Concepts

### Two-Phase Credit Hold
The mandatory financial safety protocol for billable AI operations managed between `src/systems/generation/internal/v3/core/V3Dispatcher.js` and `#billing/tools`:
1. **Reserve**: Upfront credit hold (`reserveCredits`) before queueing the BullMQ job.
2. **Protected Dispatch**: Enqueue the job via `jobQueueService.js`; if enqueueing throws, immediately release the hold (`rollbackCredits`) and mark the placeholder media as `failed` (`markMediaFailed`).
3. **Settle / Rollback**: Worker (`useCaseWorker.js`) finalizes the hold on completion (`settleCredits`) or refunds on failure (`rollbackCredits`), backed by `ReservationReaperService.js` for stale holds.

### Workflow & Workflow Run
- **Workflow (`workflows` table)**: A persistent creative unit in a project owning generated or uploaded media via `workflow_media`.
- **Workflow Run (`workflow_runs` & `node_runs` tables)**: An execution instance of a compiled V3 workflow orchestrated by `WorkflowExecutor.js`.

### Media & Save Types
Assets stored and tracked by `src/systems/media/` (`media` and `workflow_media` tables) with declarative retention, quota, and storage bucket policies defined in `src/systems/media/internal/services/saveTypes.js`.

### Character
A persistent AI influencer persona managed by `src/systems/characters/` with canonical traits, turnaround sheets, and reference media.

### Element
A reusable visual reference entity (outfit, prop, style, background) managed by `src/systems/elements/` with consistency guidelines and `@Element` prompt token resolution.

### Workspace (Projects, Folders, Trash)
Organizational hierarchy managed by `src/systems/workspace/`, providing project containers (`ProjectService.js`), cycle-safe nested folders (`FolderService.js`, `folderTree.js`), and a two-stage soft-delete trash lifecycle (`TrashService.js`).
- **Folder Deletion**: Permanently removes a folder and its nested subfolder subtree after idempotently moving all contained Workflows (and their attached Media, Characters, and Elements) into Trash and unlinking their `folder_id`. Folders themselves never enter Trash.
- **Trash (Two-Stage Workflow Soft-Delete)**: Soft-delete lifecycle keyed on `Workflow` (not raw `Media` rows) in the `trash` table. Restoring a trashed Workflow whose original folder was deleted returns it unfiled to the project root (`folder_id = null`), and deleting a folder containing already-trashed Workflows preserves them in Trash rather than permanently deleting them.
- **Bulk Workspace Delete**: Unified, explicit Move-to-Trash bulk action (`POST /api/workspace/bulk-delete`) accepting typed ID arrays (`folder_ids`, `workflow_ids`, `character_ids`, `element_ids`, max 100 total input IDs). Deduplicates overlapping folder subtrees and items, verifies ownership all-or-nothing upfront, idempotently moves all active workflows into Trash (preserving already-trashed items without permanently deleting them), unlinks workflows from deleted folders (`folder_id = null`), permanently deletes selected folder subtrees deepest-first, and directly deletes orphan Characters/Elements (`workflow_id = null`).
- **Trash Permanent Bulk Delete & Empty Trash**: Explicit permanent destruction action (`POST /api/trash/delete`) for items already in Trash — accepting either selected trashed `workflow_ids` (max 100, rejecting active non-trashed items) or `{ all: true, project_id? }` to empty Trash. Runs permanent cleanup (workflows, orphan media, storage objects, sidecar character/element rows) with configurable bounded concurrency (`BULK_DELETE_CONCURRENCY`).
