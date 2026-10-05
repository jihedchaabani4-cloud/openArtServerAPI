# Audit Review of Previously Unreviewed WIP Commits

**Scope**: Detailed audit of commits `00ac595` and `abcf370` against `main`.  
**Target Repository**: `apiOpenArt` (`hardening/phase0`)  
**Date**: 2026-10-05  

---

## 1. Executive Summary

Commits `00ac595` and `abcf370` introduced foundational queue infrastructure, background worker orchestration, repository primitives, use-case definitions, and video model pipelines. 

While these changes significantly advance backend capabilities (enabling asynchronous V2 video generation, multi-step LLM translation pipelines, and worker crash resilience), they also introduce distinct behavioral risks that require strict operational visibility:
1. **Repository Query Relaxation**: Primitives in `BaseRepository` and `WorkflowRepository` switched from `.single()` to `.maybeSingle()`, altering error contracts when querying nonexistent entities.
2. **Relational vs Tenant Authorization**: Helper guards (`lib/mediaGuards.js`) and repository methods (`ElementRepository.js`) enforce relational foreign-key consistency (e.g. `media.workflow_id === workflow_id`) rather than tenant ownership (`user_id`). They depend strictly on upstream domain layers (`assertOwns`) for tenant isolation.
3. **Queue Invariant & Worker Crash Path**: `useCaseWorker.js` adds a fallback event handler on `job failed` that automatically rolls back billing holds and sets media to `failed` if an error report is missing, eliminating orphaned holds during worker termination.
4. **New Credentials & Provider Endpoints**: Introduction of LTX video runners adds `LTX_API_KEY` to the environment and polling loops with timeout safeguards.

---

## 2. Audit Matrix

| File | Change | Risk | Evidence & Assessment |
|---|---|---|---|
| `src/queue/redis.js` | Added connection tuning (`BASE_OPTIONS`, `maxRetriesPerRequest: null`, `keepAlive`, `pingInterval`, `retryStrategy`). | **LOW** | Prevents socket disconnects on Upstash Serverless Redis. Limits reconnect attempts to 20 (~60s) to prevent infinite loops. |
| `src/services/jobQueueService.js` | Added retry loop (`DISPATCH_MAX_ATTEMPTS = 3`, 500ms delay) on BullMQ `jobQueue.add`. Wrapped queue failures in `QueueDispatchError`. | **LOW** | Fail-closed: controllers catch `QueueDispatchError` and return 503 while rolling back prepared billing holds and setting placeholders to `failed`. |
| `src/workers/worker.js` | Added `startReaper()` on boot and every 5m (`REAPER_INTERVAL_MS = 300000`). | **LOW** | Recovers abandoned holds past 10-minute TTL even if workers crash hard without SIGTERM. |
| `src/workers/useCaseWorker.js` | Added crash recovery in `useCaseWorker.on("failed")` to roll back holds and fail pending media if `err.errorReport` is absent. | **MED** | Protects user wallet on uncaught worker crashes. Relies on `err.errorReport` to prevent double-rollback on normally handled failures. |
| `src/workers/reservationReaperWorker.js` | Refactored reaper to call `mediaWorkflowLifecycleService.failForExpiredHold` for each expired hold. | **LOW** | Cleans up orphaned processing media rows alongside credit refunds. Handled inside `.catch()` so failure on one media row does not halt the reaper loop. |
| `src/db/BaseRepository.js` | Changed `findById` from `.single()` to `.maybeSingle()`. Added `deleteById(id)`. | **MED** | `.maybeSingle()` returns `null` instead of throwing `PGRST116`. Callers must explicitly check for `null`. `deleteById` lacks `user_id` parameter; must never be exposed directly to controllers without `assertOwns`. |
| `src/db/WorkflowRepository.js` | Changed `findById` from `.single()` to `.maybeSingle()`. | **MED** | Same error contract shift: returns `null` on missing row instead of throwing. Verified that `WorkflowAuthorizationService` handles `null` as 404. |
| `src/db/ElementRepository.js` | Implemented `ElementRepository` with `buildPatch` whitelist and `list({ projectId })`. | **MED** | `list` queries elements across `workflow_id` in project workflows without filtering by `user_id` in SQL. Tenant isolation depends entirely on upstream `ElementService.listProjectElements` verifying project ownership. |
| `lib/mediaGuards.js` | Guard asserting media is completed and belongs to specified `workflow_id`, `project_id`, or `session_id`. | **MED** | Throws `403` instead of `404` on relational mismatches. Does not accept `user_id` (enforces relational hierarchy, not tenant ownership). |
| `src/use-cases/definitions/videoGeneration.js` | Registered `video-generation-v1` use-case definition with 4 parameters (`prompt`, `model`, `references`, `parameters`). | **LOW** | Fully wired to V2 workflow engine. Cost resolved dynamically through pricing engine; rejects unpriced models. |
| `src/v2/registry/workflows/video-generation-v1.yaml` | Declared 3-node V2 pipeline: `llm_translate` (gemini-3.1-flash-lite), `build_prompt`, `generate` (video-generation). | **MED** | `llm_translate` is a billable node. F2.5-b / V-B pricing sweep confirmed all video models have finite pricing rules. |
| `src/v2/nodes/safety/NodeSafetyService.js` | Added moderation and safety verification for input prompts prior to generation. | **LOW** | Rejects unsafe prompts before provider dispatch, avoiding provider ban penalties and wasteful generation costs. |
| `src/models/runtime/ltx/runner.js` | New REST runner for Lightricks LTX models (`ltx_2_3_fast`, `ltx_2_3_pro`, `ltx_2_5_fast`, `ltx_2_5_pro`). | **MED** | Requires `LTX_API_KEY`. Implements polling with 504 timeout and 402 `PROVIDER_QUOTA_EXCEEDED` detection. Does not default to free; billing hold is locked prior to dispatch. |
| `src/models/manifests/ltx_*` | Manifest definitions for LTX video models and extend/retake operations. | **LOW** | Validated via `scripts/validate-all-configs.js`. |
| `src/models/manifests/gemini_3_1_flash_lite` | Manifest for Gemini 3.1 Flash Lite LLM node. | **LOW** | Pricing rule verified at 0.05 credits/call. Supported in `LLMService.js`. |

---

## 3. Deep-Dive Findings by Invariant

### 3.1 Billing & Holds
* **Finding**: `video-generation-v1.yaml` executes two billable nodes: `llm_translate` (LLM node) and `generate` (video generation node).
* **Verification**: In accordance with Task F2.5-b, `calculateWorkflowBillingPlan` computes the composite hold sum:
  $$\text{Total Cost} = \text{Cost}(\text{gemini-3.1-flash-lite}) + \text{Cost}(\text{videoModel})$$
  No billable node defaults to free ($0). If any model in the pipeline lacks a verified pricing rule, the pricing engine throws `PRICING_CONFIG_ERROR` and halts before reservation.
* **Risk**: **NONE (Mitigated)**.

### 3.2 Retries & Queue Dispatch
* **Finding**: `JobQueueService.enqueueUseCaseJob` wraps BullMQ dispatch in a retry loop with up to 3 attempts and 500ms delay.
* **Verification**: If Redis is completely unreachable after 3 attempts, it throws `QueueDispatchError`. Image and Video controllers catch this error, log `QUEUE_DISPATCH_FAILED`, immediately transition placeholder media rows to `failed`, release the billing hold, and respond with HTTP 503.
* **Risk**: **NONE (Mitigated)**.

### 3.3 Ownership & Query Filtering
* **Finding**: `BaseRepository.deleteById(id)` and `ElementRepository.list({ projectId })` do not include `user_id` filters at the SQL level.
* **Evidence**:
  * In `src/domain/element/ElementService.js`, `listProjectElements` calls `ownership.assertOwns(projectId, "project", userId)` before invoking repository methods.
  * In `tests/boundary/routeOwnershipAuditBoundary.test.js`, TEST R4-40 verifies that foreign project IDs passed to `/api/v2/elements/project/:projectId` return HTTP 404.
  * In `controllers/projectsController.js`, `update` and `remove` now verify `project.user_id === userId` before issuing update/delete queries (verified in `phase0(RC1.3-w7)`).
* **Risk**: **LOW (Protected by Service Layer)**.

### 3.4 Default-to-Free
* **Finding**: No provider runner or node executor contains fallback logic assigning `credits = 0` or skipping billing checks.
* **Evidence**: Model runner and workflow billing runtimes enforce strict checks (`typeof cost !== "number" || isNaN(cost)` throws immediately).
* **Risk**: **NONE**.

### 3.5 Environment Variables & Credentials
* **New Variables Introduced**:
  * `LTX_API_KEY`: Required only when routing video jobs to LTX models.
  * `RATE_LIMIT_CHARACTER_DESC_POINTS`: Configurable per-user rate limit (default: 10/min).
  * `RATE_LIMIT_ELEMENT_ANALYZE_POINTS`: Configurable per-user rate limit (default: 10/min).
* **Risk**: **LOW** (Documented in Section 5.2 of `docs/release/phase0-rc.md`).

---

## 4. Conclusion & Staging Readiness

The queue, database, and model additions in commits `00ac595` and `abcf370` adhere to the security, billing, and error-handling invariants established in Phase 0. All 390 unit and boundary tests pass cleanly across 66 suites with zero external dependencies and zero network requirements.
