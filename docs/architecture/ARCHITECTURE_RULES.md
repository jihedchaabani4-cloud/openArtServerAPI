# apiOpenArt — Strict Architecture Rules (`R1`–`R18`) & Operational Protocols

> **Canonical Location:** `docs/architecture/ARCHITECTURE_RULES.md`  
> **Mechanical Enforcer:** `scripts/arch-check.cjs` + `scripts/gate.cjs`  
> **Baseline Policy:** `arch-baseline.json` must remain `{}` (`0` tolerated violations).

---

## 1. Automated Rules Enforced by `scripts/arch-check.cjs` (`R1`–`R18`)

| Rule ID | Rule Name | Exact Requirement & What Fails the Build |
| :--- | :--- | :--- |
| **R1** | **No Controller -> DB Direct Access** | Controllers (`internal/controllers/*` and `public/api.js`) must never import repositories (`internal/db/*`) or database clients directly. Controllers must call `internal/services/*`. |
| **R2** | **No Raw `console.*` in Production Code** | `console.log`, `console.warn`, `console.error`, and `console.info` are forbidden in `src/`. Always use structured Pino logging via `createLogger()` from `#shared`. |
| **R3** | **No Direct `process.env` Reads** | Reading `process.env.*` directly is forbidden outside `src/shared/config/env.js`. Always import validated configuration from `#shared`. |
| **R4** | **No Cross-Domain Internal Imports** | Domain services in one system must never import internal services or models of another system directly (`MediaUploadService.js` stays generic). |
| **R5** | **Strict Data & Table Ownership** | A repository in `src/systems/<A>/internal/db/` may only query tables owned by System `<A>`. Cross-system data access must go through `#<B>/tools`. |
| **R6** | **Acyclic Dependency Direction & Migration Security** | Foundation systems (`identity`, `billing`, `media`, `models`, `workflow-engine`) must never import product orchestration systems (`generation`), and `SECURITY DEFINER` SQL migrations must `REVOKE FROM PUBLIC, anon, authenticated`. |
| **R7** | **Explicit Confirmation Checks & Typed Errors** | Confirmation checks in media/upload/storage/rollback/cleanup must use explicit `=== true` (never `!== false`), and services must throw typed `AppError` subclasses defined in `internal/errors.js`. |
| **R8** | **No Dynamic `require()` in Services & Error Hierarchy** | Services must inject dependencies instead of calling `require()` inside methods, and every system defines its error classes in `src/systems/<system>/internal/errors.js` extending `AppError` from `#shared`. |
| **R9** | **Service Ownership Header (`@owns`)** | Every `*Service.js` file must declare an `@owns` header line specifying the system and domain responsibility it owns. |
| **R10** | **Sacred `internal/` Ingress Boundary** | Outside `src/systems/<system>/`, no file may import anything from `src/systems/<system>/internal/**`. External callers may only import `#<system>/api`, `#<system>/tools`, `#shared`, or `#shared/redis` (except inside `workflow-engine`, where `#shared/redis` is forbidden). |
| **R11** | **No Self-Public Barrel Import** | Files inside `src/systems/<system>/internal/**` must never import from their own system's `public/api.js` or `public/tools.js` (prevents internal-to-barrel circular loops). |
| **R12** | **Database & Storage SDK Confinement** | `@supabase/supabase-js` and `#shared/db/supabase.js` may **only** be imported inside `src/shared/db/supabase.js`, `src/systems/*/internal/db/**`, and `src/systems/media/internal/storage/**`. |
| **R13** | **Express Framework Confinement** | `express` may only be imported inside `index.js`, `src/api/**`, `src/systems/*/public/api.js`, `src/systems/*/internal/controllers/**`, and `src/systems/*/internal/middleware/**`. Never import `express` or pass `req`/`res` into `public/tools.js` or `internal/services/**`. |
| **R14** | **Zero Static or Dynamic Import Cycles** | Tarjan's Strongly Connected Components (SCC) detector scans all static and dynamic `import`/`require` edges across `src/` (both file-level and system-level). Any cycle fails the build immediately. |
| **R15** | **Strict `package.json` `#imports` Gateways** | Every entry in `package.json#imports` must map cleanly to `#shared`, `#shared/redis`, `#shared/db/supabase.js`, or `./src/systems/<system>/public/{api,tools}.js`. Wildcard aliases exposing `internal/` are forbidden. |
| **R16** | **Zero Outbound Legacy Imports** | Files inside `src/systems/<system>/**` may only import from their own folder, `#shared`, `#shared/redis` (except `workflow-engine`), `#<other_system>/tools`, `#<other_system>/api`, or npm packages. Importing from outside paths is forbidden. |
| **R17** | **Canonical Directory Lock** | No top-level code directories (`controllers/`, `routes/`, `lib/`, `middleware/`, `services/`, `utils/`) or unauthorized `src/` subdirectories (`src/domain/`, `src/platform/`, `src/db/`, `src/models/`, `src/v2/`, `src/use-cases/`, `src/infrastructure/`, `src/runtime/`, `src/errors/`, `src/config/`, `src/queue/`, `src/workers/`) may exist. All code in `src/` must reside in `src/api/`, `src/shared/`, `src/systems/`, or `src/container.js`. |
| **R18** | **Standalone `workflow-engine` Closed Allowlist** | Enforces a closed positive import allowlist inside `src/systems/workflow-engine/**`: `internal/core/**` may import ONLY `#shared`, `node:*`, and intra-system relative paths; `internal/skills/**` may also import `"yaml"`; all other `workflow-engine/**` files may import ONLY `#shared`, `#models/tools`, `node:*`, and intra-system relative paths. `#shared/redis`, `bullmq`, `ioredis`, `redis`, `@upstash/redis`, peer domain systems, and provider SDKs are strictly forbidden. |

---

## 2. How to Write a New Service or Feature (Step-by-Step Rules)

### A. Rules for `internal/services/`
1. **Single Responsibility:** Each service file in `internal/services/` handles one coherent domain concern (e.g., `WalletService.js`, `FolderService.js`, `WorkflowDispatchService.js`).
2. **Pure DTO Inputs & Outputs:** Service methods receive plain objects (`{ userId, projectId, name }`) and return plain objects. They never read `req.headers` or call `res.status()`.
3. **Dependency Injection Ready:** Use the system's `serviceAccessor.js` or constructor injection so unit tests can pass in-memory stubs without mocking globals.
4. **Structured Logging:** Instantiate a module logger via `const logger = createLogger('system:serviceName')` from `#shared`.

### B. Rules for `internal/controllers/` and `public/api.js`
1. **`public/api.js` is the Router Declaration:** It defines Express routes (`router.get(...)`, `router.post(...)`), attaches auth/validation middlewares, and delegates to functions in `internal/controllers/`.
2. **`internal/controllers/` is the HTTP Translator:**
   - Extracts `userId = req.user?.id`.
   - Delegates domain parsing, ownership, and orchestration to `internal/services/`.
   - Returns standard JSON responses or passes errors to `next(err)`.

### C. Rules for `public/tools.js`
1. **Minimal Public Surface:** Only export functions that another Business System or background worker genuinely needs to call.
2. **DTO-Only Signatures:** Never expose raw Repository instances, Supabase clients, or Express middleware internals (except `identity` exporting `requireAuth` / `rateLimit` middlewares).

---

## 3. Mandatory Generation Intake, Dispatch & Worker Lifecycle Protocol

Every generation flow coordinated by `src/systems/generation/` and executed by `src/systems/workflow-engine/` obeys a strict two-phase separation:

### Phase 1: Synchronous Intake & Queue Dispatch (`GenerationRequestService.js` + `WorkflowDispatchService.js`)
1. **Verify Ownership & Inputs (1x Fail-Fast Gate):** Validate request contracts, ban raw HTTP URLs, verify user ownership of project, workflow, references, media params, characters, elements, and inline prompt tags via `#identity/tools`, and validate model parameters via `#models/tools`.
2. **Create Pending Media Placeholder:** Atomically persist the `workflow` and single `processing` `media` placeholder via `#media/tools` (`createGenerationPlaceholderAtomic` or `appendMediaToWorkflow`).
3. **Fail-Fast Validation & Protected Queue Dispatch:** Call `WorkflowDispatchService.dispatch(...)`, which validates the workflow & required inputs via `#workflow-engine/tools` `verifyInput()` and enqueues 1 job into BullMQ (`workflow-jobs`) with bounded retry backoff.
   - **Single-Owner Rollback on Dispatch Failure:** If enqueueing fails, `WorkflowDispatchService` throws `GenerationQueueDispatchError` (503) without firing ambient hooks; the calling intake service marks the pending placeholder `failed` (and releases any credit hold via `#billing/tools`).

### Phase 2: Asynchronous Worker Execution (`useCaseWorker.js` -> `#workflow-engine/tools`)
1. **Fresh Engine Per Job:** For each pulled BullMQ job (`concurrency: envConfig.useCaseWorkerConcurrency` [default `6`], `lockDuration: 300_000`, `lockRenewTime: 60_000`, `stalledInterval: 60_000`, `maxStalledCount: 0`), `useCaseWorker.js` calls `createWorkflowEngine({ adapters: workflowAdapters, onFailure })` from `#workflow-engine/tools` and runs `engine.runWorkflow(...)`.
2. **Pure In-Process DAG Execution:** `ExecutionEngine` verifies required adapters pre-Wave-1, creates an isolated `JobExecutionContext` (disposed in `finally`), and runs topological waves via `WorkflowExecutor` (single-attempt fail-fast, zero retries).
3. **On Success:** `base.save_media` persists the output via the injected media adapter (`persistExternalMedia` / `completeMedia`) and marks the placeholder `success`.
4. **On Error or Crash:**
   - Inside `runWorkflow`: `ExecutionEngine` sanitizes the error neutrally, attaches `err.errorReport`, and invokes the job's `onFailure` handler (`createGenerationFailureHandler({ markMediaFailed })`), which formats client-safe copy via Generation's `sanitizeClientError` and marks ONLY `serverContext.mediaIds` as `failed`.
   - Unhandled worker crash (no `err.errorReport`): `handleUseCaseWorkerFailure` runs the same `createGenerationFailureHandler`.
   - Process hard-kill (OOM/SIGKILL): `ReservationReaperService.js` in `billing` automatically sweeps expired holds and stale processing placeholders.
