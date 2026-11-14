# Handoff Report — Partie 09: System 1 — Generation & Workflows (`src/systems/generation/`)

> **Application**: `apiOpenArt` (Labveil AI Studio Backend)  
> **Branch**: `refactory-new-arch`  
> **Status**: COMPLETED & VERIFIED  
> **Date**: 2026-11-13  
> **Quality Gate Status**: PASS (1,461 tests passing, 0 failures, 0 arch-check violations)

---

## 1. Objectives Completed

In this phase, we constructed **System 1: Generation & Workflows** (`src/systems/generation/`), consolidating UseCases, BullMQ job queues, V2 DAG compiler & runner, and Prompt intelligence into a unified, strictly-bounded modular monolith system per `01_business_systems_architecture.md` and `02_architecture_rules_and_agent_guardrails.md`.

1. **Ticket 9.1: Prompt Intelligence Service & Prompt Skills (`internal/prompt/`)**
   - Implemented typed error hierarchy extending `AppError` from `#shared`: `GenerationError`, `GenerationValidationError` (400), `GenerationNotFoundError` (404), `GenerationCompilationError` (400), `GenerationQueueDispatchError` (503).
   - Encapsulated prompt services and processors in `src/systems/generation/internal/prompt/index.js`:
     - `PromptService` (with `@owns System 1: Generation & Workflows`).
     - `promptService` singleton instance.
     - `LLMService` (with `@owns System 1: Generation & Workflows`) and `llmService`.
     - `PromptBuilderProService` (from `#elements/tools`).
     - V2 prompt processors and skills (`enhancePromptProcessor`, `generateNegativePromptProcessor`, `moderationSafetyProcessor`, `optimizeVisualPromptProcessor`, camera styles, composition, etc.).

2. **Ticket 9.2: V2 DAG Compiler, Runner & Execution Gateways (`internal/runner/`)**
   - Encapsulated DAG compilation and workflow execution in `src/systems/generation/internal/runner/index.js`:
     - `compileWorkflow`, `compileWorkflowById` (DAG validation, input bindings, resolution).
     - `loadRegistries` (workflow and node registry discovery).
     - `startWorkflowRun`, `executeOrchestration` (orchestration execution and run tracking).
     - `executeNodeJob`, `resolveInputsForNode`, `executeNodePersistence` (node level execution).
     - `reserveNodeBilling`, `settleNodeBilling`, `rollbackNodeBilling`, `estimateNodeBillingAmount` (per-node ledger tracking).
     - `RunRepository` (workflow run state and node run persistence).
     - `NodeSafetyService` (input validation & sanitization for image, video, llm, and prompt nodes).
     - `bootstrapV2` (workflow engine and use case registry initialization).

3. **Ticket 9.3: UseCase Engine, Worker & Pre-Queue Launch Protocol (`internal/engine/`)**
   - Encapsulated UseCase engine, queues, and workflow services in `src/systems/generation/internal/engine/index.js`:
     - `UseCaseService` (with `@owns System 1: Generation & Workflows`): orchestrates the 5-step Pre-Queue Launch Protocol (Auth/Idempotency -> Context & Cost -> Credit Hold -> Pending Media -> Protected Queue Dispatch with rollback).
     - `jobQueueService` (with `@owns System 1: Generation & Workflows`), `getUseCaseQueue`, `USECASE_QUEUE_NAME`, `QueueDispatchError`.
     - `registerAllUseCases`, `registerUseCase`, `getUseCase`, `listUseCases`.
     - Use-case definitions (`imageGenerationUseCase`, `videoGenerationUseCase`, `characterSheetUseCase`).
     - `GenerationService` and `GenerationRequestService` (with `@owns System 1: Generation & Workflows`).
     - `WorkflowLifecycleService`, `WorkflowService`, `WorkflowAuthorizationService`, `WorkflowMediaService` (with `@owns System 1: Generation & Workflows`).

4. **Ticket 9.4: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`)**
   - Created pure DTO Tools Gateway: `src/systems/generation/public/tools.js` (`#generation/tools`):
     - `triggerWorkflowRun({ workflowId, input, userId })`: compiles and starts a workflow run.
     - `getWorkflowRun({ runId, userId })`: retrieves run details and node run records.
     - Re-exports facade members (`compileWorkflow`, `startWorkflowRun`, `UseCaseService`, `jobQueueService`, `GenerationService`, `GenerationRequestService`, `PromptService`, `promptService`, `LLMService`, etc.).
   - Created Express HTTP API Gateway: `src/systems/generation/public/api.js` (`#generation/api`) isolating express per Rule 13:
     - `imagesRouter`: `POST /api/images/generated`.
     - `videoRouter`: `POST /api/video/generated`.
     - `promptRouter`: `POST /api/prompt/optimize`.
     - `v2WorkflowsRouter`: `GET /api/v2/workflows/health`, `POST /api/v2/workflows/run`, `GET /api/v2/workflows/runs/:run_id`.
     - `workflowsRouter`: V1 CRUD, clone, library, media, and reference routes.
     - `generationRouter`: unified router mounting all generation endpoints.
   - Decoupled `db` into `src/db/dbInstance.js` and decoupled `bootstrapV2` gateways via `configureDefaultGateways`, breaking cyclic dependencies and achieving 0 static cycles across the entire codebase (Rule 14).
   - Registered `#generation/api` and `#generation/tools` in `package.json#imports` (Rule 15).
   - Maintained 100% backward compatibility via legacy re-exports:
     - `routes/images.js` -> re-exports `imagesRouter` from `#generation/api`.
     - `routes/video.js` -> re-exports `videoRouter` from `#generation/api`.
     - `routes/prompt.js` -> re-exports `promptRouter` from `#generation/api`.
     - `routes/v2/workflows.js` -> re-exports `v2WorkflowsRouter` from `#generation/api`.
     - `routes/workflows.js` -> re-exports `workflowsRouter` from `#generation/api`.
     - `src/domain/generation/index.js` -> re-exports from `#generation/tools`.
     - `src/container.js` -> imports `GenerationService`, `GenerationRequestService`, `promptService`, `UseCaseService`, `jobQueueService` from `#generation/tools`.
   - Added unit test suite: `tests/unit/generationSystem.test.js` (7 passing tests).

---

## 2. Verification & Quality Gates

| Gate Check | Command | Result |
| :--- | :--- | :--- |
| **Hermetic Test Suite** | `npm test` | **PASS**: 1,461 tests passing, 0 failures, 0 skipped |
| **System 1 Unit Tests** | `node --test tests/unit/generationSystem.test.js` | **PASS**: 7/7 passing |
| **Prompt Boundary Tests** | `node --test tests/boundary/promptOptimizationBoundary.test.js` | **PASS**: 5/5 passing |
| **Architecture Ratchet** | `npm run arch` | **PASS**: 0 new violations across R1-R15 (R14 cycles: 0, R9 remaining: 2) |
| **Service Catalog** | `npm run catalog` | **PASS**: `docs/agents/service-catalog.md` generated |
| **Doc Path Checker** | `node scripts/check-doc-paths.cjs` | **PASS**: 27 references verified in 12 docs |
| **Complete Quality Gate** | `npm run gate` | **PASS**: All 5 quality checks succeeded |

---

## 3. Next Steps (Partie 10)

- **Partie 10: Main Router Cutover & Legacy Folder Cleanup**
  - Wire `src/app.js` exclusively to the `public/api.js` gateways of all 8 Business Systems:
    1. `#generation/api`
    2. `#models/api`
    3. `#billing/api`
    4. `#media/api`
    5. `#identity/api`
    6. `#characters/api`
    7. `#elements/api`
    8. `#workspace/api`
  - Remove obsolete direct imports and cleanly retire legacy routes.
