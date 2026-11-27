---
status: accepted
supersedes: docs/adr/0005-pure-black-box-workflow-engine.md
---

# Standalone Queue-Free Black-Box Workflow Engine (`workflow-engine`)

- **Status:** Accepted *(supersedes `docs/adr/0005-pure-black-box-workflow-engine.md`)*

## Context

`ADR-0005` decoupled billing and media persistence from the V3 DAG execution core, but left structural couplings in place:
1. The DAG engine remained inside System 1 (`generation`) as an internal directory (`v3/core/`), preventing other business systems (such as `characters` for future analysis pipelines, `elements`, or standalone scripts) from invoking workflow execution directly through a clean public interface.
2. `ExecutionEngine` still imported `jobQueueService`, branched on `async: true/false`, exposed `launch()`/`execute()` queue aliases, and did not pass its `GraphCompiler` into `WorkflowExecutor` (while `GraphCompiler` stored plans in a module-global `WeakMap` shared across registries).
3. `src/shared/index.js` eagerly re-exported `src/shared/redis/index.js` with non-lazy `ioredis` connections outside test mode, making zero-Redis standalone execution impossible whenever a module imported `#shared`.
4. `Base Nodes` (`resolveRefsNode`, `saveMediaNode`) statically imported peer domain systems (`#characters/tools`, `#elements/tools`, `#media/tools`, `#identity/tools`), blocking future adoption under `Rule R14` and pulling Supabase clients into standalone scripts.
5. Ambient global failure hooks matched generic `input.media_id`, risking corruption of healthy completed media rows if a future read-only workflow fails.

## Decision

We extract the V3 Workflow Engine into its own standalone 9th Business System (`src/systems/workflow-engine/`, imported via `#workflow-engine/tools`) as a **100% pure, zero-Redis, zero-DB, single-execution Black Box**:

1. **Zero-Redis Shared Kernel Segmentation:**
   - Segment `#shared/redis` out of `#shared` (`src/shared/index.js`) into an explicit subpath export (mirroring `#shared/db/supabase.js`) and enable `lazyConnect: true` on all shared Redis clients (`redisConnection`, `workerRedisConnection`, `rateLimitRedisConnection`) without top-level eager `.connect()` calls, so importing `#shared` or `#workflow-engine/tools` never loads `ioredis` or opens TCP sockets.
   - Extract domain-agnostic `getValueByPath`, `renderTextTemplate`, `inferMediaType`/`normalizeAllowedMediaTypes`, and neutral `scrubSensitiveText`/`sanitizePublicError` into `#shared` so Generation and `workflow-engine` share one canonical implementation without violating `Rule R10`.
2. **Standalone `workflow-engine` System (`#workflow-engine/tools`):**
   - Owns the 5 pure core files (`NodeRegistry`, instance-scoped `GraphCompiler` plan cache, `JobExecutionContext`, `WorkflowExecutor` sharing its engine's `GraphCompiler`, and queue-free `ExecutionEngine`), the 7 composable Base Nodes, the 7 active `SKILL.md` skills, the 7 declarative workflow blueprints (with `imageRelightV3.js` and `imageAnglesV3.js` simplified to clean 3-node zero-LLM DAGs: `resolve_refs -> generate_image -> save_media`), and its own neutral typed error hierarchy (`WorkflowEngineError`, `WorkflowValidationError`, `WorkflowCompilationError`, `WorkflowUpstreamError`, `WorkflowNotFoundError`, `WorkflowSafetyError`) free of billing refund wording.
   - Exposes a sealed **11-export** Tools Interface (`#workflow-engine/tools`): `verifyInput`, `calculateCost`, `createWorkflowEngine`, `runWorkflow`, `configureWorkflowAdapters`, and the 6 `Workflow*Error` classes.
   - Hooks (`onSuccess`, `onFailure`) are strictly instance-scoped or per-run — zero ambient global failure hooks and zero `notifyWorkflowFailure` pub-sub boomerang on `#workflow-engine/tools`.
3. **Inverted 4-System Adapter Seam with Pre-Wave-1 Fail-Fast Validation:**
   - All 4 peer domain dependencies used by Base Nodes (`characters`, `elements`, `media`, `identity`) are injected via a 9-key `configureWorkflowAdapters(...)` seam wired once in `src/container.js` (and locked against post-boot mutation in non-test environments), leaving `workflow-engine` statically dependent ONLY on `#shared` (Redis-free) and `#models/tools` (pure leaf).
   - Adapter-dependent Base Nodes (`saveMediaNode`) declare required adapters (`getRequiredAdapters`) so `ExecutionEngine.runWorkflow()` validates configuration before Wave 1 executes (failing fast before any paid external AI provider call).
4. **Consolidated Queue Dispatch & Per-Job Worker Ownership in `generation`:**
   - `WorkflowDispatchService` (`src/systems/generation/internal/services/WorkflowDispatchService.js`) consolidates BullMQ queue ownership (`workflow-jobs`) and fail-fast `verifyInput()` validation into one cohesive service on `#generation/tools` (replacing the removed shallow queue wrapper and sealing `#generation/tools` to 7 exports). Synchronous dispatch failures throw `GenerationQueueDispatchError` (503) to the calling intake service (`GenerationRequestService` / `CharacterGenerationService`), which retains single ownership of synchronous placeholder compensation.
   - `useCaseWorker.js` owns BullMQ multi-job concurrency (`envConfig.useCaseWorkerConcurrency`, default `6`, clamped `1..20`), locks (`lockDuration: 300_000`, `lockRenewTime: 60_000`, `stalledInterval: 60_000`, `maxStalledCount: 0`), and `createGenerationFailureHandler({ markMediaFailed })` (legally importing Generation's `sanitizeClientError` inside `generation/internal/` and targeting strictly `serverContext.mediaIds`, never generic `input.media_id`). For every pulled job, it calls `createWorkflowEngine({ adapters: workflowAdapters, onFailure })` from `#workflow-engine/tools` and runs `engine.runWorkflow(...)`.
   - `imageEditContract.js` inside `generation` is the sole owner of relight/angles prompt templates and renders `prompt` once at intake (eliminating template duplication and double-rendering).
5. **Closed Positive-Allowlist Mechanical Guardrail (`Rule R18`):**
   - `Rule R18` in `scripts/arch-check.cjs` restricts `src/systems/workflow-engine/internal/core/**` exclusively to `#shared`, Node built-ins, and intra-system relative paths (`skills/**` also permits `"yaml"`), and restricts all remaining files in `src/systems/workflow-engine/**` exclusively to `#shared` and `#models/tools` as cross-system imports, while banning `#shared/redis`, `bullmq`, `ioredis`, `redis`, `@upstash/redis`, and provider SDKs.

## Alternatives Considered

1. **Keep the engine internal to `generation` (`ADR-0005`):** Rejected because peer domains (`characters`, `elements`) and standalone scripts require queue-free workflow execution without coupling to `generation` or Redis.
2. **Invert only `characters` and `elements` (2-key adapter seam):** Rejected because static imports of `#media/tools` and `#identity/tools` still pull Supabase/DB modules into standalone `workflow-engine` runs.
3. **Keep Redis inside `#shared` with `lazyConnect: true` only:** Rejected because `workflow-engine` would still load `ioredis` transitively and `Rule R18` could not mechanically block accidental Redis imports from `#shared`.

## Consequences

- **True zero-Redis, zero-DB standalone execution:** Importing and running `#workflow-engine/tools` in any Node environment (including `NODE_ENV=production`) loads zero Redis or Supabase clients and exits cleanly with zero open sockets.
- **Zero-cycle 9-system foundation:** `generation`, `characters`, `elements`, and future systems can all call `#workflow-engine/tools` with zero `Rule R14` cycles and zero blast-radius interference from Generation failure hooks.
- **Single-source utilities and templates:** Pure path resolution, template rendering, media-type classification, and neutral error scrubbing live once in `#shared`; relight/angles templates live once in `generation`.
- **Media surface cleanup stays decoupled:** Deepening `#media/tools` (43 -> ~18 exports) remains an independent follow-up task after this extraction passes `npm run gate`.
