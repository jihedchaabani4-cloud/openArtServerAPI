# GLOSSARY.md — Canonical Domain & Architectural Vocabulary (`apiOpenArt`)

> **Canonical Location:** `docs/agents/GLOSSARY.md`  
> This glossary defines the authoritative domain and architectural terminology across all 9 Business Systems in `apiOpenArt`.

---

## 1. Architectural Concepts

### Business System
A self-contained black-box module located in `src/systems/<system>/` (`generation`, `models`, `billing`, `media`, `identity`, `characters`, `elements`, `workspace`, `workflow-engine`). Exposes functionality exclusively via `public/api.js` (HTTP Web Gateway, for systems with HTTP routes) and `public/tools.js` (System Tools Interface). All implementation details live strictly inside `internal/`.

### Web Gateway (`public/api.js`)
An Express router exposing HTTP endpoints (`req, res`) mounted by the Main Router (`src/api/routes.js`). Responsible for route definitions, attaching auth/rate-limit/upload middlewares, and delegating to `internal/controllers/`.

### Tools Interface (`public/tools.js`)
The contract of async functions and DTO factories exposed to other Business Systems, background workers, and `src/container.js` via `#<system>/tools`.

### Internal Boundary (`internal/`)
Strictly private controllers (`internal/controllers/`), services (`internal/services/`), database repositories (`internal/db/`), and domain errors (`internal/errors.js`) of a Business System. External files are forbidden from importing anything inside `internal/` (`Rule R10`).

### Shared Technical Kernel (`src/shared/` / `#shared` & `#shared/redis`)
Pure technical utilities with zero domain business logic: validated environment config (`src/shared/config/env.js`), raw Supabase factory (`src/shared/db/supabase.js`), base error classes and neutral public sanitization (`src/shared/errors/AppError.js`, `src/shared/errors/sanitizeError.js`), structured Pino logging (`src/shared/logger/index.js`), pure helpers (`pathUtils.js`, `templateUtils.js`, `mediaTypeUtils.js`, `ratioUtils.js`, `assetDto.js`), and lazy-connected Redis singletons segmented behind `#shared/redis` (`src/shared/redis/index.js`, `lazyConnect: true`) so pure systems like `workflow-engine` and `models` never load `ioredis`.

### Main API Router (`src/api/routes.js`)
The single HTTP entry point mounting all 8 `#<system>/api` routers plus health/readiness probes (`src/api/probes/health.js`, `src/api/probes/ready.js`).

---

## 2. Domain & Operational Concepts

### Two-Phase Credit Hold
The mandatory financial safety protocol for billable AI operations enforced at the domain/billing boundary via `#billing/tools` — never coupled inside `ExecutionEngine.js` core:
1. **Reserve**: Upfront credit hold (`reserveCredits`) placed before dispatching the BullMQ job.
2. **Protected Dispatch**: Enqueue the job via `WorkflowDispatchService.js`; if enqueueing throws `GenerationQueueDispatchError` (503), the calling intake service immediately releases the hold (`rollbackCredits`) and marks placeholder media as `failed`.
3. **Settle / Rollback**: Settle the hold (`settleCredits`) on completion or refund (`rollbackCredits`) on failure/crash, backed by `ReservationReaperService.js` for stale holds.

### Workflow & Workflow Run
- **Workflow (`workflows` table)**: A persistent creative unit in a project owning generated or uploaded media via `workflow_media`.
- **Workflow Run**: An ephemeral in-memory/queued execution instance of a compiled V3 workflow identified by `runId` / `executionId` inside an isolated `JobExecutionContext` (`JobExecutionContext.js`) and orchestrated by `WorkflowExecutor.js`.

### Standalone Workflow Engine (`workflow-engine`)
System 9 (`src/systems/workflow-engine/`): a standalone, 100% queue-free, DB-free, and domain-agnostic DAG execution system exposing a sealed 11-export Tools Interface (`#workflow-engine/tools`: `verifyInput`, `calculateCost`, `createWorkflowEngine`, `runWorkflow`, `configureWorkflowAdapters`, and the 6 neutral `Workflow*Error` classes). Enforced by `Rule R18`, it knows nothing about Redis, BullMQ, workers, multi-job concurrency, Supabase, or HTTP controllers; peer domain capabilities (`characters`, `elements`, `media`, `identity`) are injected via a 9-key adapter seam wired in `src/container.js`. Lifecycle hooks (`onSuccess`, `onFailure`) are strictly instance-scoped or per-run.

### Workflow Dispatch Service (`WorkflowDispatchService.js`)
The consolidated queue-publishing service inside `src/systems/generation/internal/services/WorkflowDispatchService.js` (exported on `#generation/tools`). Validates inputs fail-fast via `#workflow-engine/tools` `verifyInput()`, owns the BullMQ `workflow-jobs` producer queue with bounded 3-attempt enqueue backoff, returns `{ status: "queued", workflowId, executionId, runId, workflowRunId, jobId }`, and throws `GenerationQueueDispatchError` (503) on failure so intake services retain single ownership of synchronous placeholder compensation.

### 4-Layer Composable V3 Architecture
The locked separation of responsibilities across the V3 Generation & Edit pipeline so Base Nodes remain composable into future Composite Nodes and User Workflows:
- **Layer 1 — API, Intake Guards & Queue Dispatch (`generation`)**: Thin HTTP adapters delegating to domain intake services (`GenerationRequestService.js`, `CharacterGenerationService.js`) for auth, ownership (1x fail-fast gate), rate limits, domain validation, concurrency guards, placeholder creation, and asynchronous Redis enqueueing via `WorkflowDispatchService.js`.
- **Layer 2 — Standalone Pure Workflow Engine (`workflow-engine`)**: Queue-free, single-execution DAG compiler and parallel wave executor exposing `verifyInput`, `calculateCost`, `createWorkflowEngine`, `runWorkflow`, and per-instance/per-run lifecycle hooks (`onSuccess` / `onFailure`), with zero Redis, BullMQ, billing, DB, or domain coupling.
- **Layer 3 — Pure Base Nodes**: Stateless, single-responsibility DAG units (`internal/nodes/base/*`) with a strict `inputs -> execute() -> outputs` contract, adapter injection for peer domain lookups/persistence, zero billing/queue/retry awareness, and report-don't-decide typed error handling.
- **Layer 4 — Storage & DB Tools (`media` & `billing`)**: Idempotent permanent object-storage persistence, real media dimension extraction, atomic DB completion guards, compensating storage discard on commit failure, and Two-Phase Credit Holds.

### Fail-Fast Generation Policy & Worker Lock Safety
AI generation executions run single-attempt fail-fast (`maxAttempts: 1` on `ImageGenerateNode`, `VideoGenerateNode`, and `LlmNode`; `maxRetries: 0` default in `RuntimeExecutor`) while keeping status polling alive for already-submitted async provider jobs (capped at `180s` for WaveSpeed image/edit/upscale/remove-background and `600s` for video). On any failure or stall, `useCaseWorker.js` (`concurrency: envConfig.useCaseWorkerConcurrency` [default `6`, clamped `1..20`], `lockDuration: 300_000`, `lockRenewTime: 60_000`, `stalledInterval: 60_000`, `maxStalledCount: 0`) spawns one fresh isolated `createWorkflowEngine({ adapters, onFailure })` per job, fails closed without re-executing the provider call, and invokes `createGenerationFailureHandler({ markMediaFailed })` strictly on explicit `serverContext.mediaIds`.

### Service-Role Repository Access
All server-side database repositories across the DB-backed Business Systems default to `supabaseAdmin || supabase` so background workers (`useCaseWorker`, `walletWorker`, reapers) and HTTP services never fail under RLS in production while ownership checks are enforced explicitly at the service/controller boundary. (`models` and `workflow-engine` are stateless and DB-free.)

### Media & Save Types
Assets stored and tracked by `src/systems/media/` (`media` and `workflow_media` tables) with declarative retention, quota, and storage bucket policies defined in `src/systems/media/internal/services/saveTypes.js`.

### In-Place Image Edit (Relighting & Camera Angles)
A single-output image transformation (`Relighting` or `Camera Angles`) targeting an existing `Workflow` by `workflow_id`:
- **Server-Resolved Source Media**: The client sends only `workflow_id` (never `media_id`); the backend resolves the workflow's current primary `Media` (`is_primary = true`), validates ownership, completed status, and non-trashed workflow state, and records it as `source_media_id` in `generation_config`.
- **Parent Ownership**: Appends a new `Media` row to the same `Workflow` (never creating a duplicate workflow) while preserving all prior media rows intact.
- **Immediate Primary Selection**: The newly created edit placeholder immediately becomes the workflow's primary media (`is_primary = true`) upon creation, allowing successive edits on the same `workflow_id` to chain automatically.
- **Server-Locked Model**: The underlying image-editing model is fixed on the server per edit use case and cannot be chosen or overridden by the client.
- **Relighting**: Re-illuminates the workflow's primary image using explicit single-light controls (`light_type`, `brightness`, `color`, `size`, `rotation`, `tilt`, optional `distance`) while preserving subject identity and composition. Rendered once in `imageEditContract.js` and executed as a 3-node zero-LLM DAG (`resolve_refs -> generate_image -> save_media`).
- **Camera Angles**: Re-renders the workflow's primary image from a new virtual camera pose defined by `rotation`, `tilt`, and `zoom` while preserving subject, scene, and lighting continuity. Rendered once in `imageEditContract.js` and executed as a 3-node zero-LLM DAG (`resolve_refs -> generate_image -> save_media`).

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
