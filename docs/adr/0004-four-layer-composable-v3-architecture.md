---
status: accepted
---

# Four-Layer Composable V3 Execution Architecture

As `apiOpenArt` expands from fixed single-purpose endpoints (`image-generation-v3`, `image-edit-v3`, `image-relight-v3`, `image-angles-v3`, `image-remove-background-v3`) toward future Composite Nodes (Sub-Workflows) and a User Workflow Builder, mixing billing/hold checks into DAG nodes or hardcoding media-table persistence into the execution engine breaks composability. A user workflow may contain zero, one, or multiple save nodes, and every Base Node must remain a pure reusable building block.

We locked the V3 Generation & Edit Engine into **4 strict layers**:

1. **Layer 1 — API & Intake Guards (`src/systems/generation/internal/services/GenerationRequestService.js`, controllers):** Owns HTTP validation, auth, ownership checks, rate limits, domain guards, and concurrency locks. Never runs DAG nodes directly.
2. **Layer 2 — Execution Engine (`src/systems/generation/internal/v3/core/ExecutionEngine.js`, `src/systems/generation/internal/v3/core/WorkflowExecutor.js`, `src/systems/generation/internal/v3/core/JobExecutionContext.js`):** Sole owner of execution lifecycle, upfront credit holds, heartbeats, centralized pre-node `holdExpired` enforcement (checked before every node and retry attempt), retries, credit settlement, and compensating rollback on failure.
3. **Layer 3 — Pure Base Nodes (`src/systems/generation/internal/v3/nodes/base/`):** Stateless, single-responsibility DAG units following a strict `inputs -> execute() -> outputs` contract with zero billing or credit-hold logic. On failure, a node cleans up only its own local side effect and throws a typed domain error for Layer 2 to handle.
4. **Layer 4 — Storage & DB Tools (`src/systems/media/public/tools.js`):** Owns idempotent permanent Supabase Storage persistence (`persistExternalMedia`, skipping upload when `asset_url` already resides in our bucket), real `width`/`height` extraction, atomic in-flight DB completion guards (`status === 'processing'` / `pending` and `hold_expired !== true` in `completeMedia`), and immediate compensating `discard([storageKey])` whenever a DB commit fails after upload.

## Considered Options

1. **Move media persistence & `completeMedia` into `ExecutionEngine.execute` (`Engine.end()`):** Rejected. Breaks composability whenever a future Composite Node or User Workflow has 0 save nodes (text-only workflow) or 2+ save nodes (e.g., saving both original and upscaled outputs), and couples the generic engine directly to media persistence semantics.
2. **Keep `ctx.holdExpired` checks inside individual Base Nodes (such as `SaveMediaNode`):** Rejected. Allows an expired hold to keep executing upstream LLM/image provider nodes before finally failing at the terminal node, and leaks billing-hold concepts into composable Base Nodes.
3. **Strict 4-Layer Composable Architecture (chosen):** Keeps `ExecutionEngine` + `WorkflowExecutor` completely generic across all DAG topologies while centrally halting before any node on `holdExpired`, and keeps `SaveMediaNode` a pure `inputs -> execute() -> outputs` node backed by Layer 4's unified, compensating `persistExternalMedia` -> `completeMedia` pipeline.

## Consequences

- **Composability preserved:** Any set of Base Nodes can be wrapped in future Composite Nodes or assembled freely by users without modifying `ExecutionEngine` or billing logic.
- **Zero expiring provider URLs in production:** `ExecutionEngine.execute` enables `useExternalPersistence: !envConfig.isTest` by default so external WaveSpeed/LTX URLs are downloaded, inspected for real dimensions, and uploaded to Supabase Storage before `completeMedia()` commits and credits settle.
- **No orphan storage objects on DB/Reaper races:** If `completeMedia()` rejects (e.g., `HOLD_EXPIRED` or DB failure), `persistExternalMedia` immediately invokes `uploadService.discard([storageKey])`.
- **Fail-fast billing protection:** When `startHoldHeartbeat` detects a terminal hold expiry, it marks `jobCtx.markHoldExpired()` so `WorkflowExecutor` halts immediately before starting the next node.
