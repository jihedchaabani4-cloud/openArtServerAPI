# apiOpenArt — Strict Architecture Rules (`R1`–`R17`) & Operational Protocols

> **Canonical Location:** `docs/architecture/ARCHITECTURE_RULES.md`  
> **Mechanical Enforcer:** `scripts/arch-check.cjs` + `scripts/gate.cjs`  
> **Baseline Policy:** `arch-baseline.json` must remain `{}` (`0` tolerated violations).

---

## 1. Automated Rules Enforced by `scripts/arch-check.cjs` (`R1`–`R17`)

| Rule ID | Rule Name | Exact Requirement & What Fails the Build |
| :--- | :--- | :--- |
| **R1** | **No Controller -> DB Direct Access** | Controllers (`internal/controllers/*` and `public/api.js`) must never import repositories (`internal/db/*`) or database clients directly. Controllers must call `internal/services/*`. |
| **R2** | **No Raw `console.*` in Production Code** | `console.log`, `console.warn`, `console.error`, and `console.info` are forbidden in `src/`. Always use structured Pino logging via `createLogger()` from `#shared`. |
| **R3** | **No Direct `process.env` Reads** | Reading `process.env.*` directly is forbidden outside `src/shared/config/env.js`. Always import validated configuration from `#shared`. |
| **R4** | **No Cross-Domain Internal Imports** | Domain services in one system must never import internal services or models of another system directly (`MediaUploadService.js` stays generic). |
| **R5** | **Strict Data & Table Ownership** | A repository in `src/systems/<A>/internal/db/` may only query tables owned by System `<A>`. Cross-system data access must go through `#<B>/tools`. |
| **R6** | **Acyclic Dependency Direction & Migration Security** | Foundation systems (`identity`, `billing`, `media`, `models`) must never import product orchestration systems (`generation`), and `SECURITY DEFINER` SQL migrations must `REVOKE FROM PUBLIC, anon, authenticated`. |
| **R7** | **Explicit Confirmation Checks & Typed Errors** | Confirmation checks in media/upload/storage/rollback/cleanup must use explicit `=== true` (never `!== false`), and services must throw typed `AppError` subclasses defined in `internal/errors.js`. |
| **R8** | **No Dynamic `require()` in Services & Error Hierarchy** | Services must inject dependencies instead of calling `require()` inside methods, and every system defines its error classes in `src/systems/<system>/internal/errors.js` extending `AppError` from `#shared`. |
| **R9** | **Service Ownership Header (`@owns`)** | Every `*Service.js` file must declare an `@owns` header line specifying the system and domain responsibility it owns. |
| **R10** | **Sacred `internal/` Ingress Boundary** | Outside `src/systems/<system>/`, no file may import anything from `src/systems/<system>/internal/**`. External callers may only import `#<system>/api` or `#<system>/tools`. |
| **R11** | **No Self-Public Barrel Import** | Files inside `src/systems/<system>/internal/**` must never import from their own system's `public/api.js` or `public/tools.js` (prevents internal-to-barrel circular loops). |
| **R12** | **Database & Storage SDK Confinement** | `@supabase/supabase-js` and `#shared/db/supabase.js` may **only** be imported inside `src/shared/db/supabase.js`, `src/systems/*/internal/db/**`, and `src/systems/media/internal/storage/**`. |
| **R13** | **Express Framework Confinement** | `express` may only be imported inside `index.js`, `src/api/**`, `src/systems/*/public/api.js`, `src/systems/*/internal/controllers/**`, and `src/systems/*/internal/middleware/**`. Never import `express` or pass `req`/`res` into `public/tools.js` or `internal/services/**`. |
| **R14** | **Zero Static or Dynamic Import Cycles** | Tarjan's Strongly Connected Components (SCC) detector scans all static `import`/`require` edges across `src/`. Any cycle (`length > 1` or self-loop) fails the build immediately. |
| **R15** | **Strict `package.json` `#imports` Gateways** | Every entry in `package.json#imports` must map cleanly to `#shared` or `./src/systems/<system>/public/{api,tools}.js`. Wildcard aliases exposing `internal/` are forbidden. |
| **R16** | **Zero Outbound Legacy Imports** | Files inside `src/systems/<system>/**` may only import from their own folder, `#shared`, `#<other_system>/tools`, `#<other_system>/api`, or npm packages. Importing from outside paths is forbidden. |
| **R17** | **Canonical Directory Lock** | No top-level code directories (`controllers/`, `routes/`, `lib/`, `middleware/`, `services/`, `utils/`) or unauthorized `src/` subdirectories (`src/domain/`, `src/platform/`, `src/db/`, `src/models/`, `src/v2/`, `src/use-cases/`, `src/infrastructure/`, `src/runtime/`, `src/errors/`, `src/config/`, `src/queue/`, `src/workers/`) may exist. All code in `src/` must reside in `src/api/`, `src/shared/`, `src/systems/`, or `src/container.js`. |

---

## 2. How to Write a New Service or Feature (Step-by-Step Rules)

### A. Rules for `internal/services/`
1. **Single Responsibility:** Each service file in `internal/services/` handles one coherent domain concern (e.g., `WalletService.js`, `FolderService.js`).
2. **Pure DTO Inputs & Outputs:** Service methods receive plain objects (`{ userId, projectId, name }`) and return plain objects. They never read `req.headers` or call `res.status()`.
3. **Dependency Injection Ready:** Use the system's `serviceAccessor.js` or constructor injection so unit tests can pass in-memory stubs without mocking globals.
4. **Structured Logging:** Instantiate a module logger via `const logger = createLogger('system:serviceName')` from `#shared`.

### B. Rules for `internal/controllers/` and `public/api.js`
1. **`public/api.js` is the Router Declaration:** It defines Express routes (`router.get(...)`, `router.post(...)`), attaches auth/validation middlewares, and delegates to functions in `internal/controllers/`.
2. **`internal/controllers/` is the HTTP Translator:**
   - Extracts `userId = req.user?.id`.
   - Validates request payload schemas.
   - Calls `internal/services/`.
   - Returns standard JSON responses or passes errors to `next(err)`.

### C. Rules for `public/tools.js`
1. **Minimal Public Surface:** Only export functions that another Business System or background worker genuinely needs to call.
2. **DTO-Only Signatures:** Never expose raw Repository instances, Supabase clients, or Express middleware internals (except `identity` exporting `requireAuth` / `rateLimit` middlewares).

---

## 3. Mandatory Financial & Media Lifecycle Protocol

Every billable generation flow in `src/systems/generation/` must obey the **5-Step Pre-Queue Launch & 3-Step Worker Settlement Protocol**:

### Phase 1: Synchronous Launch (`ExecutionEngine.js`)
1. **Verify Ownership & Inputs:** Validate input schema and verify user ownership of any referenced characters, elements, media, and inline prompt tags via `#identity/tools` (`assertOwns` / `assertOwnsAny`).
2. **Calculate Deterministic Cost:** Compile the active DAG via `GraphCompiler.js` and `#models/tools` (`calculateCost`) with strict fail-closed pricing.
3. **Reserve Credits (Hold):** Call `#billing/tools` (`reserveCredits`) with an idempotency key to lock the user's credits before touching the queue.
4. **Create Pending Media Placeholder:** Reuse a caller-supplied `media_id` or call `#media/tools` (`createPendingMedia`) to create 1 trackable `processing` media record.
5. **Protected Queue Dispatch:** Enqueue 1 independent job in BullMQ (`jobQueueService.addUseCaseJob`).
   - **Mandatory Rollback on Dispatch Failure:** If `addUseCaseJob` throws an error, the `catch` block **must** immediately call `#billing/tools` (`rollbackCredits`) AND `#media/tools` (`markMediaFailed`) for this run's media so neither the user's credits nor the pending media row are left dangling.

### Phase 2: Asynchronous Worker Execution (`useCaseWorker.js` & `ExecutionEngine.js`)
1. **Execute DAG / Provider:** Construct an isolated per-job `JobExecutionContext.js` (per-job cache disposed in `finally`) and run the workflow waves via `WorkflowExecutor.js` calling `#models/tools` (`executeGeneration` / `executeLLM`).
2. **On Success:**
   - Persist output media from the provider's temporary URL into permanent storage via `#media/tools`.
   - Finalize the credit deduction via `#billing/tools` (`settleCredits`).
3. **On Error or Crash:**
   - Refund the user's credits immediately via `#billing/tools` (`rollbackCredits`).
   - Mark ONLY this run's `pendingMediaId` as `failed` via `#media/tools` (`markMediaFailed`).
   - If a worker process dies unexpectedly (OOM/SIGKILL), `ReservationReaperService.js` in `billing` automatically releases expired holds.
