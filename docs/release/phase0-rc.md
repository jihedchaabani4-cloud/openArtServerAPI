# Phase 0 Release Candidate Pack

**Target Release Branch**: `hardening/phase0`  
**Base Branch**: `main`  
**Generated Date**: 2026-10-05  
**Test Suite Status**: 314 tests passing across 55 test files (0 failures)

---

## 1. Git Changes Summary & Commit Log

### 1.1 Diffstat Summary by Functional Area

Total changes: **66 files changed, 11,012 insertions(+), 1,457 deletions(-)**

```text
Area                                             Files Changed    Insertions    Deletions
─────────────────────────────────────────────────────────────────────────────────────────
Controllers & API Routing                                    6           951          382
Domain Services (Character, Element)                         4          1493          860
Platform (AI, Billing, Storage, Ownership, RateLimit)       8           880          220
Models Layer & Provider Runtime Registry                     3            50            4
V2 Workflow Engine, Nodes, Resolvers, Error Policy          13          1084          250
Infrastructure, Database & Container                         5           147           37
Database Migrations (007 + rollback)                         2            32            0
Boundary & Integration Test Suites                          25          6375           78
─────────────────────────────────────────────────────────────────────────────────────────
TOTAL                                                       66         11012         1457
```

#### Detailed File List per Area

* **Controllers & API Routing**:
  * `controllers/characterController.js` (+128, -133)
  * `controllers/elementController.js` (+142, -137)
  * `controllers/imageController.js` (+242, -128)
  * `controllers/videoController.js` (+279, -0) [NEW]
  * `controllers/v2/workflowsController.js` (+15, -0)
  * `routes/prompt.js` (+10, -1)

* **Domain & Application Services**:
  * `src/domain/character/CharacterGenerationService.js` (+231, -0) [NEW]
  * `src/domain/character/CharacterService.js` (+281, -277)
  * `src/domain/element/ElementAnalysisService.js` (+11, -6)
  * `src/domain/element/ElementService.js` (+352, -335)
  * `src/services/useCaseService.js` (+135, -40)
  * `src/services/walletService.js` (+35, -4)
  * `src/use-cases/useCaseRunner.js` (+18, -6)
  * `src/use-cases/workflowBillingPlan.js` (+57, -16)

* **Platform, Storage, Security & Billing**:
  * `src/config/rateLimitPolicies.js` (+48, -0) [NEW]
  * `src/middleware/rateLimit.js` (+121, -0) [NEW]
  * `src/platform/ai/LLMService.js` (+61, -15)
  * `src/platform/ai/PromptService.js` (+26, -7)
  * `src/platform/billing/WalletService.js` (+72, -28)
  * `src/platform/media/MediaLifecycleService.js` (+79, -0) [NEW]
  * `src/platform/security/ownership.js` (+233, -0) [NEW]
  * `src/platform/storage/StorageService.js` (+142, -41)

* **Models Layer & Provider Runtime**:
  * `src/models/execution/modelRunner.js` (+14, -0)
  * `src/models/index.js` (+7, -1)
  * `src/models/runtime/providerRuntimeRegistry.js` (+28, -0) [NEW]

* **V2 Engine, Nodes & Resolvers**:
  * `src/v2/nodes/imageGenerationNode.js` (+114, -75)
  * `src/v2/nodes/index.js` (+7, -1)
  * `src/v2/nodes/llmNode.js` (+98, -38)
  * `src/v2/nodes/promptBuilderNode.js` (+1, -1)
  * `src/v2/nodes/videoGenerationNode.js` (+146, -0) [NEW]
  * `src/v2/registry/workflows/character-sheet-v1.yaml` (+2, -2)
  * `src/v2/resolvers/WorkflowReferenceResolver.js` (+66, -45)
  * `src/v2/runner/nodeExecutor.js` (+148, -37)
  * `src/v2/runner/runRepository.js` (+69, -28)
  * `src/v2/runner/workflowRunner.js` (+294, -63)
  * `src/v2/runtime/errorPolicy.js` (+41, -14)
  * `src/v2/runtime/useCaseBillingRuntime.js` (+30, -10)
  * `src/runtime/errorPolicy.js` (+18, -9)

* **Infrastructure & Database Migrations**:
  * `migrations/007_v2_workflow_runs_targets.sql` (+25, -0) [NEW]
  * `migrations/007_v2_workflow_runs_targets_rollback.sql` (+7, -0) [NEW]
  * `src/container.js` (+51, -17)
  * `src/db/MediaRepository.js` (+23, -0)
  * `src/infrastructure/billing/workflowBillingGateway.js` (+15, -6)

* **Boundary & Integration Test Suites**:
  * 21 boundary suites under `tests/boundary/`

---

### 1.2 Ordered Commit List (from `main` to `hardening/phase0`)

1. `bba5777` - `phase0(T1): require auth, rate limiting, and user billing on prompt optimization`
2. `1f7be46` - `phase0(T2a): enforce project ownership in image and video generation controllers`
3. `d7a3ef6` - `phase0(T2b): enforce character and element ownership across all CRUD and generation paths`
4. `07c784d` - `phase0(T2c): enforce reference and media ownership across controllers and WorkflowReferenceResolver`
5. `05a6b3d` - `phase0(T3): disable direct POST /api/v2/workflows/run endpoint by default via feature flag`
6. `aed10f0` - `phase0(T4): enforce SSRF mitigation and source policy in StorageService.uploadFromUrl`
7. `2da8d46` - `phase0(T5): eliminate implicit noCharge in LLMService and enforce userId propagation`
8. `96c6ff3` - `phase0(T6): fail run and rollback billing on orchestration errors`
9. `3625d03` - `phase0(T7): fail node and trigger error policy on media persistence failure`
10. `7f80a65` - `phase0(T8): atomically fail all sibling media placeholders on failure and deadlock`
11. `59d8353` - `phase0(T9): fail closed on moderation errors and unify moderated prompts`
12. `c071638` - `phase0(T10): eliminate reaper race conditions via hold heartbeats and terminal placeholder protection`
13. `3842d28` - `phase0(T11): persist billing accumulator to run metadata for distributed worker safety`
14. `c0da23d` - `phase0(F1): enforce clean BILLING_CONTEXT_MISSING error and userId propagation across all LLM callers`
15. `5935978` - `phase0(F1-followup): classify BILLING_CONTEXT_MISSING as SERVER_FAULT 500, remove llmNode fallback, and revert test process.exit`
16. `51084f4` - `phase0(F1.1): remove PromptService fallback, eliminate llmNode userId spoofing, and return INTERNAL_ERROR on SERVER_FAULT`
17. `d42573d` - `phase0(F2): enforce server-side workflow and media target IDs, remove characterId fallback, and harden failure logging`
18. `0faecf1` - `phase0(test): add workflowRunContextAndFailureBoundary to test script`
19. `f167758` - `phase0(F2.1): enforce fail-closed media targets, surface accumulator persistence errors, and verify usecase settlement invariants`
20. `f89dbfb` - `phase0(F2.2): add migration 007 for run targets, wire entry points, and enforce fail-closed columns`
21. `f46d82a` - `phase0(F2.3): enforce server targets, ensure hold rollback on all failures, and add entry point integration tests`
22. `fbd1876` - `phase0(F2.4-a): enforce boot check in production, prevent free runs on missing wallet, and restrict NO_CHARGE to price 0`
23. `f430454` - `phase0(F2.4-b): enforce multi-asset output contract, fail closed on asset count mismatch, and clamp server output count`
24. `d5956d3` - `phase0(F2.4-b4): add ctx._runFn seam, fix surplus to map-first-N with warning, verify no double-count from multi-field outputMaps`
25. `11a76c3` - `phase0(F2.4-b5): re-do node tests through providerRuntimeRegistry seam, remove ctx._runFn, and add model/provider to surplus warning`
26. `2fefa4c` - `phase0(F2.4-a1): enforce strict zero-price rule, invalid amounts throw PRICING_CONFIG_ERROR`
27. `953b2d9` - `phase0(F2.4-b2): add controller error-path boundary tests for image and video controllers`
28. `c51458c` - `phase0(F2.5-a): restrict registerProviderRunner to NODE_ENV=test, remove from public facade, add guard test`
29. `526d5e3` - `phase0(F2.5-b): register PRICING_CONFIG_ERROR in errorPolicy, return INTERNAL_ERROR + traceId, test pricing failure at prepare time`
30. `357d423` - `phase0(F2.5-c): controller error-path tests for character entry points and real prepareAndEnqueue`

---

## 2. Database Migrations

### 2.1 Forward Migration
**File**: `migrations/007_v2_workflow_runs_targets.sql`

```sql
-- Migration 007: V2 Workflow Runs Targets and Metadata
ALTER TABLE v2_workflow_runs
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS v1_workflow_id UUID,
  ADD COLUMN IF NOT EXISTS target_media_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN v2_workflow_runs.v1_workflow_id IS 'References the V1 workflow table row (public.workflow.id) producing media assets. Distinct from v2_workflow_runs.workflow_id which identifies the workflow definition (e.g. image-generation-v1). No foreign key constraint enforced.';
COMMENT ON COLUMN v2_workflow_runs.target_media_ids IS 'JSON array of pre-allocated media IDs authorized for finalization by this run.';
COMMENT ON COLUMN v2_workflow_runs.metadata IS 'Run-level metadata, including persisted billing accumulator entries and runtime context.';

CREATE INDEX IF NOT EXISTS idx_v2_workflow_runs_v1_workflow_id
  ON v2_workflow_runs (v1_workflow_id)
  WHERE v1_workflow_id IS NOT NULL;
```

### 2.2 Verification Query (One-Line)
Run this SQL query against Supabase / PostgreSQL:
```sql
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'v2_workflow_runs' AND column_name IN ('metadata', 'v1_workflow_id', 'target_media_ids');
```
*Expected Result*: Exactly 3 rows returned (`metadata`: jsonb, `v1_workflow_id`: uuid, `target_media_ids`: jsonb).

### 2.3 Rollback Script
**File**: `migrations/007_v2_workflow_runs_targets_rollback.sql`

```sql
-- Rollback Migration 007: Drop targets & metadata from v2_workflow_runs
DROP INDEX IF EXISTS idx_v2_workflow_runs_v1_workflow_id;

ALTER TABLE v2_workflow_runs
  DROP COLUMN IF EXISTS target_media_ids,
  DROP COLUMN IF EXISTS v1_workflow_id,
  DROP COLUMN IF EXISTS metadata;
```

---

## 3. Environment Variables

| Variable | Scope | Type | Default | Failure Mode if Missing / Misconfigured |
| :--- | :--- | :--- | :--- | :--- |
| `NODE_ENV` | Global | String (`production` \| `test` \| `development`) | **`production` (fail-safe)** | **Inverted default**: Any value other than explicit `"development"` or `"test"` (including unset) is treated as production mode. Enforces strict boot assertions (`WalletService`, `INTERNAL_SECRET >= 32`, `RATE_LIMIT_STORE=redis`). |
| `SUPABASE_URL` | Infrastructure / Wallet | String (URL) | `undefined` | In production mode, boot crashes immediately with `Fatal: WalletService is required in production mode... Missing: SUPABASE_URL`. In dev/test, wallet falls back to unconfigured state; requests requiring credits throw `WALLET_NOT_CONFIGURED` (never free). |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_KEY`) | Infrastructure / Wallet | String (Secret) | `undefined` | In production mode, boot crashes immediately with `Fatal: WalletService is required in production mode... Missing: SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY`. |
| `ENABLE_V2_WORKFLOW_RUN_ENDPOINT` | Feature Flag | String (`"true"` \| `"false"`) | `"false"` (unset) | Missing or not `"true"`: `POST /api/v2/workflows/run` responds with HTTP 404 (`ENDPOINT_DISABLED`). Direct orchestration endpoint remains dark. |
| `RATE_LIMIT_STORE` | Rate Limiter | String (`"memory"` \| `"redis"`) | `"redis"` (required in prod) | In production mode, **must be `"redis"`** or boot throws. If `"memory"` or unset, boot crashes unless `ALLOW_IN_MEMORY_RATE_LIMIT=true` is explicitly provided. In dev/test, defaults to `"memory"`. |
| `ALLOW_IN_MEMORY_RATE_LIMIT` | Rate Limiter / Staging Escape | String (`"true"` \| `"false"`) | `undefined` | In production mode, if set to `"true"`, permits running in-memory rate limiting with a loud startup warning (`CRITICAL SECURITY WARNING`). For single-instance staging environments only. |
| `INTERNAL_SECRET` | Auth / Internal S2S | String | `undefined` | In production mode, boot crashes immediately if missing or `< 32` characters. Constant-time timing-safe comparison enforced. Default secret eliminated. |
| `INITIAL_WALLET_BALANCE` / `DEFAULT_WALLET_BALANCE` | Wallet | Number | `0` | Default credits granted when a new user wallet row is provisioned. Defaults to 0 (no free credits without explicit config). |

---

## 4. Behavior Changes Visible to API Clients

1. **Disabled Direct Workflow Endpoint (`POST /api/v2/workflows/run`)**:
   * Previously: Endpoint was accessible and could run arbitrary workflow templates directly.
   * Now: Returns **HTTP 404 Not Found** with payload:
     ```json
     { "ok": false, "error": "ENDPOINT_DISABLED", "message": "POST /api/v2/workflows/run is disabled..." }
     ```
   * Clients must invoke specific use-case endpoints (`/api/images/generate`, `/api/video/generate`, `/api/characters/generate-sheet`).

2. **Prompt Optimization (`POST /api/prompt/optimize`)**:
   * **Authentication Required**: Unauthenticated requests now return **HTTP 401 Unauthorized**.
   * **Rate Limiting**: Limited to 20 requests per minute per user. Exceeding requests return **HTTP 429 Too Many Requests**:
     ```json
     { "ok": false, "code": "RATE_LIMIT_EXCEEDED", "message": "Too many requests. Please slow down." }
     ```
   * **Wallet Billing**: Deducts 1 credit per optimization call. If balance is insufficient, returns **HTTP 400/402 Insufficient Credits**.

3. **Strict Ownership Enforcement (Zero IDOR)**:
   * `projectId`: Must belong to the calling user. If foreign or nonexistent, returns **HTTP 404 Not Found** (`PROJECT_NOT_FOUND`).
   * `references`, `input_image`, `parameters.images`: All referenced UUIDs must belong to the calling user across `workflow`, `media`, `character`, `element`. Foreign IDs return **HTTP 404 Not Found**.
   * **Direct URLs Forbidden**: Raw HTTP/HTTPS URLs passed into `references` or image parameters return **HTTP 400 Bad Request** ("Direct image URLs are not permitted in references. Use workflow IDs only.").

4. **Multi-Asset Count & Capability Enforcement**:
   * `parameters.count`: Restricted to 1..4. If `count > 1` is requested on models that do not declare multi-candidate output capabilities in their manifest, the request fails with **HTTP 422 Unprocessable Entity** (`UNSUPPORTED_CAPABILITY`).
   * On supported models, server allocates exactly `count` placeholder records and reserves `baseCost * count` credits.

5. **Surplus & Shortage Provider Contract**:
   * **Surplus**: If a provider returns more assets than placeholders (e.g. 2 assets for 1 placeholder), the node maps the first N assets, logs a structured warning (`event: "output.asset.surplus"`), drops unrequested assets, and succeeds cleanly.
   * **Shortage**: If provider returns fewer assets than placeholders, node fails closed, transitions placeholders to `failed`, and rolls back billing.

6. **Sanitized Error Responses & Fail-Closed Guarantee**:
   * Unexpected internal 500 errors in controllers now return clean, sanitized payloads without stack traces or secrets:
     ```json
     { "ok": false, "code": "INTERNAL_ERROR", "message": "Failed to generate image", "traceId": "..." }
     ```
   * **Queue Dispatch Failure**: If Redis/BullMQ is down during generation enqueue, clients receive **HTTP 503 Service Unavailable** (`QUEUE_DISPATCH_FAILED`). All pre-allocated media placeholders are marked `status: "failed"`, and the billing hold is released/rolled back **EXACTLY ONCE**. Zero stuck `"processing"` rows remain.
   * **Pricing Configuration Error**: Any model with non-finite or missing price throws `PRICING_CONFIG_ERROR` (SERVER_FAULT) at prepare time; placeholders fail and zero hold is reserved.

---

## 5. Deployment Architecture, Environment Checklist & Migrations Pack

### 5.1 Process Entrypoints & Runtime Roles

The backend codebase defines four distinct Node.js process entrypoints:

| Entrypoint | Start Command | Primary Role | Queues Listened / Concurrency | Boot Invariants & Fail-Safes |
|---|---|---|---|---|
| `index.js` | `npm run start` (`node index.js`) | Web API Server | None (enqueues jobs to Redis via `JobQueueService`) | Enforces `NODE_ENV=production` checks: rejects missing/short `INTERNAL_SECRET` (<32 chars), rejects `RATE_LIMIT_STORE !== "redis"`, rejects `DEV_AUTH_BYPASS === "true"`. Starts in-memory hold expiration sweep every 10m. |
| `src/workers/worker.js` | `npm run start:worker` (`node src/workers/worker.js`) | Main Generation & UseCase Worker + Reservation Reaper | `usecase-queue` (concurrency: 10) | Runs `bootstrapV2()`. Starts `reservationReaperWorker` immediately at boot and then every 5 minutes (`REAPER_INTERVAL_MS = 300000`) to harvest orphaned holds past 10m TTL. |
| `src/v2/queue/v2WorkflowWorker.js` | `npm run start:v2-worker` (`node src/v2/queue/v2WorkflowWorker.js`) | Dedicated V2 Workflow Worker (alias of `useCaseWorker`) | `usecase-queue` (concurrency: 10) | Specialized container target for orchestrating workflow execution nodes independently. |
| `src/workers/walletWorker.js` | `npm run start:wallet-worker` (`node src/workers/walletWorker.js`) | Dedicated Wallet Maintenance Worker | `wallet-maintenance` (concurrency: 1) | **Strict boot assertion**: exits immediately (`process.exit(1)`) if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing. Never shares Redis connection with generation queues. Handles `expire-stale-holds`, `retry-failed-ops`, `reconcile-wallets`. |

---

### 5.2 Environment Variables Checklist (Staging & Production)

Every environment variable required or recognized by the backend:

| Variable | Required? | Staging Default | Production Requirement | Boot / Runtime Enforcement |
|---|---|---|---|---|
| `NODE_ENV` | **YES** | `staging` | `production` | Guards all fail-safes. In `production`, insecure flags cause fatal boot exceptions. |
| `PORT` | Optional | `3001` | `3001` (or PaaS assigned) | Port for Express HTTP listener. |
| `FRONTEND_URL` | **YES** | `https://staging.openart.ai` | `https://openart.ai` | Used for CORS origin validation (credentials: true). |
| `INTERNAL_SECRET` | **YES** | Random 32+ char hex | Random 32+ char high-entropy secret | In `production`, boot throws if missing or length < 32. Checked via constant-time buffer comparison. Old hardcoded fallback removed. |
| `RATE_LIMIT_STORE` | **YES** | `redis` | `redis` (STRICT) | In `production`, boot throws if not `"redis"` (`assertEnvConfig`). Prevents multi-instance memory leaks / bypasses. |
| `DEV_AUTH_BYPASS` | NO | `false` | Must NOT be `"true"` | In `production`, boot throws if `"true"` (`assertEnvConfig`). Forbidden outside local dev. |
| `SUPABASE_URL` | **YES** | `https://<ref>.supabase.co` | `https://<ref>.supabase.co` | Required at boot by `lib/supabase.js` and `walletWorker.js`. |
| `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | **YES** | Staging Service Role Key | Prod Service Role Key (NEVER anon key for backend) | Required for administrative DB operations, bypasses, and wallet operations. |
| `REDIS_URL` | **YES** | `rediss://default:<pw>@<host>:6379` | Dedicated Redis / Upstash endpoint | Required for BullMQ job queues and Redis rate limiter store. |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Optional | Fallback if `REDIS_URL` omitted | Fallback if `REDIS_URL` omitted | Used by `src/queue/redis.js` if `REDIS_URL` unset. |
| `ENABLE_V2_WORKFLOW_RUN_ENDPOINT` | NO | `false` | `false` (Omitted) | Feature flag disabling direct `POST /api/v2/workflows/run` until Phase 3. Returns 404 when false. |
| `RATE_LIMIT_CHARACTER_DESC_POINTS` | NO | `10` (points/min) | `10` | Rate limit cap on `POST /api/characters/generate-description`. Scoped by user. |
| `RATE_LIMIT_ELEMENT_ANALYZE_POINTS` | NO | `10` (points/min) | `10` | Rate limit cap on `POST /api/v2/elements/analyze`. Scoped by user. |
| `RATE_LIMIT_PROMPT_OPTIMIZE_POINTS` | NO | `20` (points/min) | `20` | Rate limit cap on `POST /api/prompt/optimize`. Scoped by user. |
| `GEMINI_API_KEY` | **YES** | Valid Google AI key | Production Google AI key | Required for LLM node execution (`gemini-3.1-flash-lite`, prompt optimizer). |
| `FAL_KEY` | **YES** | Valid Fal.ai key | Production Fal.ai key | Required for image/video generation models running on Fal. |
| `HUGGINGFACE_API_KEY` | Optional | Staging key | Production key | Required for models routing to HuggingFace Inference. |

---

### 5.3 Consolidated Database Migrations Pack

The following migrations **MUST** be verified and applied on the database prior to deploying HEAD.

#### Migration 1: `migrations/007_v2_workflow_runs_targets.sql`
* **Purpose**: Adds execution metadata and explicit target persistence pointers to `v2_workflow_runs`. Allows the V2 runner and node executor to tie execution status directly back to pre-allocated media records.
* **Code in HEAD that depends on it**:
  * `src/v2/runner/runRepository.js:14` (selects and inserts `metadata`)
  * `src/v2/runner/nodeExecutor.js:43` (`executeNodePersistence` verifies `target_media_ids` and `v1_workflow_id`)
  * **Failure without it**: PostgREST fails with error code `PGRST204: Could not find the 'metadata' column of 'v2_workflow_runs' in the schema cache`.
* **Execution SQL**:
  ```sql
  ALTER TABLE public.v2_workflow_runs
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS v1_workflow_id UUID REFERENCES public.workflow(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS target_media_ids UUID[] DEFAULT '{}'::uuid[];

  CREATE INDEX IF NOT EXISTS idx_v2_workflow_runs_v1_workflow_id ON public.v2_workflow_runs(v1_workflow_id);
  ```
* **Rollback SQL** (`migrations/007_v2_workflow_runs_targets_rollback.sql`):
  ```sql
  DROP INDEX IF EXISTS idx_v2_workflow_runs_v1_workflow_id;
  ALTER TABLE public.v2_workflow_runs
    DROP COLUMN IF EXISTS target_media_ids,
    DROP COLUMN IF EXISTS v1_workflow_id,
    DROP COLUMN IF EXISTS metadata;
  ```
* **Verification Query**:
  ```sql
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'v2_workflow_runs'
    AND column_name IN ('metadata', 'v1_workflow_id', 'target_media_ids');
  ```
* **Schema Reload**:
  ```sql
  NOTIFY pgrst, 'reload schema';
  ```

#### Migration 2: `migrations/20260924_drop_element_keywords_tags.sql`
* **Purpose**: Drops legacy redundant columns `keywords` and `tags` from `public.element`.
* **Code in HEAD that depends on it**: `src/domain/element/ElementService.js` (no longer queries or returns keywords/tags).
* **Execution SQL**:
  ```sql
  ALTER TABLE public.element
    DROP COLUMN IF EXISTS keywords,
    DROP COLUMN IF EXISTS tags;
  ```
* **Rollback SQL**:
  ```sql
  ALTER TABLE public.element
    ADD COLUMN IF NOT EXISTS keywords TEXT[] DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::text[];
  ```
* **Verification Query**:
  ```sql
  SELECT column_name FROM information_schema.columns 
  WHERE table_name = 'element' AND column_name IN ('keywords', 'tags');
  -- Expected: 0 rows
  ```
* **Schema Reload**:
  ```sql
  NOTIFY pgrst, 'reload schema';
  ```

#### Migration 3: `migrations/20260925_convert_element_guidelines_to_text.sql`
* **Purpose**: Converts `guidelines` column in `public.element` from legacy JSON array to plain text string to support prompt synthesis.
* **Code in HEAD that depends on it**: `src/domain/element/ElementService.js`, `src/domain/element/ElementAnalysisService.js`.
* **Execution SQL**:
  ```sql
  ALTER TABLE public.element ALTER COLUMN guidelines DROP DEFAULT;
  ALTER TABLE public.element ALTER COLUMN guidelines TYPE TEXT USING guidelines::text;
  ALTER TABLE public.element ALTER COLUMN guidelines SET DEFAULT '';
  UPDATE public.element SET guidelines = '' WHERE guidelines = '[]' OR guidelines = '[""]' OR guidelines IS NULL;
  ```
* **Rollback SQL**:
  ```sql
  -- Not strictly reversible without data loss if plain text was entered; can revert column default:
  ALTER TABLE public.element ALTER COLUMN guidelines DROP DEFAULT;
  ALTER TABLE public.element ALTER COLUMN guidelines SET DEFAULT '';
  ```
* **Verification Query**:
  ```sql
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'element' AND column_name = 'guidelines';
  -- Expected: data_type = 'text'
  ```
* **Schema Reload**:
  ```sql
  NOTIFY pgrst, 'reload schema';
  ```

---

### 5.4 Deployment Steps (In Order)

1. **Pre-flight Environment Check**:
   * Verify all required environment variables in Section 5.2 are populated in CI/CD secrets and container environment.
   * Verify `ENABLE_V2_WORKFLOW_RUN_ENDPOINT="false"`.

2. **Execute Database Migrations**:
   * Apply migrations in order: `007_v2_workflow_runs_targets.sql`, `20260924_drop_element_keywords_tags.sql`, `20260925_convert_element_guidelines_to_text.sql`.
   * Run verification queries for each migration.
   * Send Supabase PostgREST schema cache reload signal:
     ```sql
     NOTIFY pgrst, 'reload schema';
     ```

3. **Queue Drain Step**:
   * Prior to restarting worker containers, allow active jobs in BullMQ queues (`usecase-queue`, `wallet-maintenance`) to finish:
     * In staging/production: issue a graceful SIGTERM to workers, or call `queue.pause()` to prevent new job pickup while active jobs complete.
     * Ensure no jobs remain in active state.

4. **Deploy Backend Services**:
   * Deploy updated API server containers (`index.js`).
   * Deploy updated worker processes (`src/workers/worker.js` and `src/workers/walletWorker.js`).

5. **Post-Deployment Verification**:
   * Inspect container startup logs for `assertEnvConfig()` and `assertWalletConfiguredForEnvironment()`.
   * Execute manual staging verification smoke tests (Section 6).

---

### 5.5 Rollback Plan

If critical regressions or alerts occur:
1. **Pause Workers**: Pause BullMQ queues to stop picking up new jobs.
2. **Revert Application Containers**: Redeploy the previous stable Docker image / release commit.
3. **Database Schema Rollback** (Only if necessary):
   * Run `migrations/007_v2_workflow_runs_targets_rollback.sql`.
   * Columns dropped: `target_media_ids`, `v1_workflow_id`, `metadata`.
   * Run `NOTIFY pgrst, 'reload schema';`.
4. **Resume Workers**: Unpause queues and verify previous workers recover.

---

## 6. Manual Staging Verification Checklist

| # | Test Scenario | Steps | Expected Result | Pass/Fail |
| :- | :--- | :--- | :--- | :-: |
| 1 | **Server Boot Check** | Start API server in `NODE_ENV=production` with missing `SUPABASE_URL`. | Server exits immediately with fatal configuration error log. | [ ] |
| 2 | **Normal Server Boot** | Start API server in `NODE_ENV=production` with full Supabase credentials. | Server boots successfully; logs confirm wallet configured. | [ ] |
| 3 | **Direct Run Disabled** | `POST /api/v2/workflows/run` with dummy payload. | **404 Not Found** with `code: "ENDPOINT_DISABLED"`. | [ ] |
| 4 | **Prompt Optimize Auth** | `POST /api/prompt/optimize` without `Authorization` header. | **401 Unauthorized**. | [ ] |
| 5 | **Prompt Optimize Rate Limit** | Send 25 rapid optimize requests with valid user JWT. | First 20 succeed; 21st+ returns **429 Too Many Requests** (`RATE_LIMIT_EXCEEDED`). | [ ] |
| 6 | **Prompt Optimize Billing** | Send 1 optimize request for user with 5 credits. | **200 OK**; user balance decreases by exactly 1 credit. | [ ] |
| 7 | **Image Generation (Single)** | `POST /api/images/generate` with prompt, valid project ID, model `nanobana_2`. | **200 OK**; media placeholder created with `status: "processing"`; job processes; placeholder updates to `status: "completed"` with valid image URL. | [ ] |
| 8 | **IDOR Project Ownership** | `POST /api/images/generate` passing a `project_id` owned by User B while authenticated as User A. | **404 Not Found** (`PROJECT_NOT_FOUND`). No placeholders created. | [ ] |
| 9 | **IDOR Reference Ownership** | `POST /api/images/generate` passing reference media owned by User B. | **404 Not Found**. No job enqueued. | [ ] |
| 10 | **Direct URLs Forbidden** | `POST /api/images/generate` with `parameters: { input_image: "https://evil.com/img.png" }`. | **400 Bad Request** rejecting direct URLs. | [ ] |
| 11 | **Video Generation** | `POST /api/video/generate` with prompt, valid project ID, model `wan_3_0`. | **200 OK**; video media placeholder created; job enqueued; wallet hold reserved. | [ ] |
| 12 | **Character Sheet Generation** | `POST /api/characters/:characterId/generate-sheet`. | **200 OK**; sheet placeholder created; usecase enqueued; hold reserved. | [ ] |
| 13 | **Queue Down Error Handling** | Temporarily disconnect Redis, then call `POST /api/images/generate`. | **503 Service Unavailable** (`QUEUE_DISPATCH_FAILED`); placeholders marked `status: "failed"`; hold released; zero stuck processing rows. | [ ] |
| 14 | **Multi-Candidate Clamp/422** | Request `parameters.count = 4` on a single-image model (e.g. `nanobana_2`). | **422 Unprocessable Entity** (`UNSUPPORTED_CAPABILITY`) or clamped; hold matches allocated placeholders. | [ ] |

---

## 7. Known Limitations

1. **Multi-Candidate Generation**:
   * Models without multi-asset support declared in manifests reject `count > 1` with `UNSUPPORTED_CAPABILITY` (422) or clamp to 1.
2. **V2 Direct Endpoint Remains Dark**:
   * `POST /api/v2/workflows/run` is intentionally disabled behind feature flag `ENABLE_V2_WORKFLOW_RUN_ENDPOINT=true` pending Phase 3 rollout.
3. **Provider Runners**:
   * Google (`nanobana_pro`, `gemini`) and WaveSpeed (`nanobana_2`, `gpt_image_2`, `wan_3_0`, `seedance_2_5`) execute via vendor SDK clients; LTX models execute via REST runners with validated response mappings.
4. **Reaper Cleanup Heartbeats**:
   * The hold reaper relies on heartbeat updates on active workflow runs. In case of catastrophic worker loss without SIGTERM, holds expire after `HOLD_TTL_SECONDS` (10 minutes) and are released automatically.
