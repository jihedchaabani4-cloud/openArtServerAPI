---
status: superseded
superseded_by: docs/adr/0006-standalone-queue-free-workflow-engine.md
---

# Pure Black-Box 3-Tool Workflow Engine

- **Status:** Superseded by `docs/adr/0006-standalone-queue-free-workflow-engine.md` *(previously superseded Layer 2's billing ownership in `docs/adr/0004-four-layer-composable-v3-architecture.md`)*

## Context

In `docs/adr/0004-four-layer-composable-v3-architecture.md`, Layer 2 (`ExecutionEngine` and `WorkflowExecutor`) was decoupled from media persistence (`base.save_media`), yet still carried responsibility for billing holds, heartbeats, settlement, and media-failure cleanup. As `apiOpenArt` expands to support deterministic zero-LLM edit pipelines (`image-relight-v3`, `image-angles-v3`, `image-remove-background-v3`), non-media/generic DAG workflows (`base.text_template` -> `base.extract`), and future user-composed workflows, embedding billing, ownership, or media concerns inside the execution core makes the engine harder to reuse, test in isolation, and reason about.

At the same time, keeping the 8-system modular-monolith topology tight (`Rule R10`–`Rule R17`) means we should not introduce unnecessary cross-system surface area or premature system proliferation.

## Decision

We lock `src/systems/generation/internal/v3/core/` as a **100% domain-agnostic, strictly internal Black-Box Workflow Engine** inside System 1 (`generation`):

1. **Strictly internal to System 1 (`generation`):** The 5 core files (`ExecutionEngine.js`, `GraphCompiler.js`, `WorkflowExecutor.js`, `NodeRegistry.js`, `JobExecutionContext.js`) remain inside `src/systems/generation/internal/v3/core/`. They are NOT extracted into a 9th Business System and their methods are NOT exported as 3 standalone functions on `src/systems/generation/public/tools.js` (`#generation/tools`).
2. **Minimal 3-tool internal API on `ExecutionEngine`:**
   - `verifyInput(workflowOrId, input)` — 100% pure read-only dry-run (zero DB/Redis side effects) that **never throws**; resolves the workflow, validates `requiredInputs`, compiles the DAG, and returns `{ valid, workflowId, missing, errors }`.
   - `calculateCost(workflowOrId, input)` — 100% pure read-only dry-run that resolves and compiles the workflow, resolves planned inputs (`INPUT_TYPES` defaults + static literals + `{ fromInput }` bindings), and sums each active node's `estimateCost(plannedInputs)` fail-closed into `{ totalCredits, breakdown }`.
   - `runWorkflow(workflowOrId, input, opts)` — unified execution entrypoint supporting both modes:
     - `async: true` (default): merges `serverContext`, validates via `verifyInput`, enqueues 1 job to BullMQ (`workflow-jobs`) via `jobQueueService.js`, and returns `{ status: "queued", workflowId, executionId, runId, workflowRunId, jobId }`. <!-- no-check -->
     - `async: false`: executes the compiled DAG synchronously via `WorkflowExecutor` inside an isolated `JobExecutionContext`, classifies and sanitizes errors (`ErrorSystem` + `sanitizeClientError`), invokes external lifecycle hooks (`onSuccess` / `onFailure`), disposes the context in `finally`, and returns execution outputs. `useCaseWorker.js` delegates directly to `engine.runWorkflow(..., { async: false, ... })`.
   - `launch(params)` and `execute(params)` remain on `ExecutionEngine` strictly as thin backward-compatible aliases delegating to `runWorkflow(..., { async: true / false, ... })`.
3. **Zero domain coupling in `v3/core/`:** None of the 5 core files import or reference `#billing/tools`, `#identity/tools`, `#media/tools`, characters, elements, or projects. This supersedes Layer 2's billing ownership from `docs/adr/0004-four-layer-composable-v3-architecture.md`; Two-Phase Credit Holds live at the domain/billing boundary via `#billing/tools`.
4. **External lifecycle hooks (`onSuccess` / `onFailure`):** Domain side effects attach outside the core at composition time. For example, `src/container.js` registers `executionEngine.onFailure(...)` to call `markMediaFailed` from `#media/tools` whenever a media-backed workflow fails at dispatch, execution, or worker crash.

## Alternatives Considered

1. **Extract `v3/core/` into a 9th Business System (e.g., `src/systems/workflow-engine/`):** Rejected. Today only System 1 (`generation`, plus System 6 `characters` delegating sheet runs through `executionEngine`) uses the DAG engine. Adding a 9th system would multiply `#imports` wiring, container boilerplate, and boundary tests without a second independent bounded context. If a second domain ever needs standalone workflow execution, `v3/core/` is already 100% decoupled and can be lifted cleanly later.
2. **Export `verifyInput`, `calculateCost`, and `runWorkflow` as 3 standalone functions on `#generation/tools` (`src/systems/generation/public/tools.js`):** Rejected. Exposing low-level engine primitives directly on the public cross-system gateway invites peer systems to bypass Layer 1 intake guards (ownership checks, domain validation, placeholder creation, and billing boundaries). Callers outside System 1 continue to enter through `GenerationRequestService` or the wired `executionEngine` instance injected by `src/container.js`.
3. **Keep billing holds, heartbeats, and settlement inside `ExecutionEngine` (`ADR-0004` Layer 2):** Rejected. Tightly couples every DAG execution (including 0-credit deterministic or non-billable internal workflows) to wallet state and forces billing mocks into pure workflow-engine tests.

## Consequences

- **True black-box testability & reuse:** `verifyInput`, `calculateCost`, and `runWorkflow({ async: false })` run completely hermetically on any declarative DAG (including zero-credit generic pipelines) with zero database, Redis, or billing dependencies.
- **Strict domain separation:** `ExecutionEngine.js` and `useCaseWorker.js` stay minimal and domain-agnostic; media failure compensation is wired once in `src/container.js` via `executionEngine.onFailure(...)`, and billing holds remain owned by `#billing/tools`.
- **Single-surface maintenance:** Consolidating launch and execution behind `runWorkflow(workflowOrId, input, { async })` eliminates drift between queue-dispatch validation and direct execution while preserving backward compatibility via thin `launch`/`execute` aliases.
- **Explicit boundary discipline:** Because `v3/core/` never enforces ownership or billing itself, callers handling untrusted user requests must still pass through Layer 1 guards (`GenerationRequestService.js` / `#billing/tools`), and `base.resolve_references` retains `verify_ownership: true` as its fail-closed default when called directly.
