# Business Systems Architecture Rules (`apiOpenArt`)

> **Target Architecture**: Modular Monolith of encapsulated **Business Systems** running in one Node.js ESM application (`apiOpenArt/`), backed by Express, Supabase Postgres/Storage, and BullMQ/Redis. Each System owns its internal implementation and data, exposing only a small, deliberate public capability surface.

---

## Preserved Architectural Decisions

These locked repository decisions remain in force and govern any System boundary work:

1. **Physical Storage**: `StorageService` (`apiOpenArt/src/platform/storage/StorageService.js`) owns physical binary storage, key construction, folder allowlisting, and storage provider delegation — zero database tables.
2. **Canonical Media Records**: `MediaService` (`apiOpenArt/src/platform/media/MediaService.js`) owns `public.media` (`step_id` = technical provenance per ADR-0008).
3. **Workflow-Media Relations**: `WorkflowMediaService` (`apiOpenArt/src/platform/workflow/WorkflowMediaService.js`) owns `public.workflow_media` (`role`, `is_primary`, atomic `attach_workflow_reference_media` RPC, and 4-step rollback per ADR-0006, ADR-0007, ADR-0010, ADR-0012).
4. **Stateless Upload Pipeline**: `MediaUploadService` (`apiOpenArt/src/platform/media-ingestion/MediaUploadService.js`) owns stateless binary validation (magic bytes, per-type size, count), >2048px WebP optimization, upload, and compensating `discard(storageKeys)` — zero DB access and zero `Element`/`Character`/`Workflow` awareness (ADR-0012).
5. **Persistence Isolation**: Repositories own all database access; circular dependencies and cross-System database access are forbidden.
6. **Workflow Freeze**: **Do NOT start Workflow System refactoring** without explicit human approval.

---

## Rules

### Rule 1 — Architectural Taxonomy

Every backend file belongs to exactly one of six roles:

| Role | Owns | Visibility |
|---|---|---|
| **Business System** | Domain invariants, entities, and Postgres tables (or Foundation state) for multiple consumers | Public **only** via its single `index.js` alias |
| **Public Capability** | One verb-noun operation on a System's `index.js` with validated input, typed output, and System errors | Public across Systems / Application / Controllers |
| **Internal Service** | Single business responsibility inside one System (`*Service.js`) | **Private** to its owning System |
| **Repository** | Supabase/Postgres queries & RPC calls for one System's owned tables (`*Repository.js`) | **Private** to its owning System |
| **Application / Execution Coordinator** | Cross-System workflows, job admission, and execution state (`src/use-cases/`, `src/v2/`, `UseCaseService`) | Called by Controllers and Workers; never imported by Systems |
| **Platform** | Cross-cutting technical primitives (`createLogger`, `redisConnection`, BullMQ transport, env/config, `lib/supabase.js` client factory) | Shared technical layer; **not** a Business System; zero domain rules |

- **Check**: Every backend module can be classified into one row above; Platform modules contain zero domain terms (`Workflow`, `Element`, `Character`, credit pricing).
- **Good**: `createLogger("billing")` (`src/infrastructure/logging/index.js`) is Platform; `Billing` is a Business System; `WalletService` is an Internal Service inside `Billing`.
- **Bad**: Treating `redisConnection` (`src/queue/redis.js`) or `createLogger` as a Business System, or putting workflow-type branching inside `src/infrastructure/` (`WorkflowStorageGateway.persistMediaResult`).

---

### Rule 2 — When Something Qualifies as a Business System

Create a Business System **only** when it **(a) owns persistent domain tables** (or an approved Foundation state boundary: `Storage` buckets, `Models` manifests/bindings) **AND (b) serves multiple distinct consumers**. Everything else is an Internal Service inside an existing System or a Platform utility.

- **Check**: Every `SYSTEM.md` lists >= 1 owned table (or documented Foundation state) and >= 2 distinct callers outside the System.
- **Good**: `Media` owns `public.media` and serves Upload, Generation, Workflow, and Project Read -> qualifies as a Business System. `ElementAnalysisService` owns no tables and serves only `ElementService` -> stays a private Internal Service inside `Element`.
- **Bad**: Promoting `ElementAnalysisService`, `PromptBuilderProService`, or `WorkflowQueueGateway` (7-line wrapper over `enqueueTreatmentJob`) into standalone Business Systems.

---

### Rule 3 — Single Public Surface (`index.js` + Exact Import Alias)

Each System exposes **one** entry file (`index.js`) mapped to **one exact alias** in `apiOpenArt/package.json` `"imports"`. Wildcard aliases (`*`) that expose a System's internal files and relative deep imports across System folders are forbidden. `index.js` never exports repositories, internal service classes, or database clients.

- **Check**: In `package.json` `"imports"`, every System key maps to `./src/.../<system>/index.js` with no `*`; zero non-System files import paths inside another System's folder.
- **Good** *(target pattern — illustrative)*:
  ```json
  { "imports": { "#systems/media": "./src/systems/media/index.js" } }
  ```
  ```js
  import { createMediaRecord, MediaNotFoundError } from "#systems/media";
  ```
- **Bad** *(current legacy pattern to eliminate per phase)*:
  ```json
  { "imports": { "#platform/media/*.js": "./src/platform/media/*.js" } }
  ```
  ```js
  import { MediaWorkflowLifecycleService } from "#platform/media/MediaLifecycleService.js";
  import { WorkflowMediaService } from "../../platform/workflow/WorkflowMediaService.js";
  ```

---

### Rule 4 — Public Capability Contract

Every capability exported by a System's `index.js` must have:
1. **Verb-noun name** (`attachMediaItems`, `reserveCredits`, `calculateCost`).
2. **JSDoc `@typedef`** for input and output DTOs (never raw DB rows or open `...extra` pass-throughs).
3. **Compiled Ajv schema** (`ajv` + `ajv-formats`) validating inputs where data crosses a System boundary.
4. **Explicit `@throws` list** naming only that System's error classes.
5. **Explicit caller/tenant context parameter** (`ctx: { userId, projectId?, requestId? }`) — never implicit globals.
6. **Documented authorization rule** stating ownership scope (`userId` + `projectId`, `404` on mismatch) or internal-only caller requirement.

- **Check**: Every exported function in `index.js` has an input/output `@typedef`, compiled Ajv validator at entry, explicit `ctx` parameter, `@throws` tag, and auth note in `SYSTEM.md`.
- **Good** *(target pattern — illustrative)*:
  ```js
  /**
   * @typedef {{ userId: string, projectId: string, requestId?: string }} TenantContext
   * @typedef {{ projectId: string, url: string, stepId: string, width: number, height: number }} CreateMediaInput
   * @typedef {{ id: string, projectId: string, url: string, status: 'processing'|'success'|'failed' }} MediaDto
   * @param {CreateMediaInput} input
   * @param {TenantContext} ctx - Verifies project belongs to ctx.userId (404 on mismatch).
   * @returns {Promise<MediaDto>}
   * @throws {MediaValidationError | MediaNotFoundError}
   */
  export async function createMedia(input, ctx) { /* validateSchema(input, ctx) -> service */ }
  ```
- **Bad**:
  ```js
  // Untyped ...extra spread into DB, no ctx.userId, no Ajv validation, undocumented errors
  export async function createMedia({ projectId = null, url, ...extra } = {}) { ... }
  ```

---

### Rule 5 — Strict Data & Table Ownership

Every Postgres table has **exactly one** owning Business System declared in its `SYSTEM.md`. Only that System's private `*Repository.js` classes may query, mutate, or call mutating RPCs on that table. Passing a shared multi-domain `db` bag (`db.media`, `db.workflows`, `db.elements`) across Systems is forbidden. Any cross-System multi-table query exception must be a **read-only Documented Read Model** explicitly approved in `SYSTEM.md`.

- **Check**: Each table name in `.from("<table>")` appears in repositories of at most one System (plus approved read-only Read Models with zero `.insert`/`.update`/`.delete`/mutating `.rpc`).
- **Good**: `Element` calls `Workflow` / `Media` public capabilities to attach reference media instead of writing to `public.workflow_media` or `public.media` directly.
- **Bad**: Injecting the global `db` map (`src/container.js`) into `CharacterService`, `ElementService`, and `TrashService` so any service can call `this.db.workflows` or `this.db.media` directly.

---

### Rule 6 — Acyclic Downward Dependency Direction

Dependencies point strictly downward with **zero cycles** (static imports or runtime setter callbacks):
`Controllers/Routes` -> `Application / Execution Coordinators` -> `Upper Domain Systems` -> `Foundation Systems` (`Identity/Security`, `Storage`, `Billing`, `Models`, `Media`) -> `Platform`.
Every `SYSTEM.md` declares its explicit `Allowed Dependencies` and `Forbidden Dependencies`. Foundation Systems never depend on Upper Domain Systems or Application coordinators.

- **Check**: The System import graph is a DAG; Foundation Systems have zero imports from `src/domain/`, `src/use-cases/`, `src/v2/`, or setter hooks (`setWorkflowService`, `setEntitySyncHandlers`).
- **Good**: `GenerationRequestService` (Upper/Application) calls `Models` (`calculateCost`) and `Billing` (`reserve`); neither `Models` nor `Billing` imports `Generation` or `Character`.
- **Bad**: `folderService.setWorkflowService(workflowService)` and `workflowService.setEntitySyncHandlers({ syncCharacter, syncElement })` (`src/container.js`), or `CharacterService` calling `UseCaseService` upward.

---

### Rule 7 — Creating an Internal Service Inside a System

Every Internal Service (`*Service.js`) inside a System must satisfy all seven invariants:
1. **Single responsibility** declared in a top-of-file `@owns <one sentence>` comment (ratchet `R9`).
2. **Private to its System** — never imported outside its System folder.
3. **Constructor-injected dependencies** — throws immediately on missing required deps; no `require()` in methods (`R8`), no `new OtherService()`, no `if (dep.method)` shims.
4. **No direct database client** — zero `supabase.from(...)` or `createClient(...)`; all SQL/RPC calls live in the System's `*Repository.js`.
5. **Structured logging** via `createLogger("<module>")` with entity IDs and storage keys only — never `console.*` (`R2`), secrets, tokens, signed URLs, or prompts.
6. **System-typed errors** — throws only subclasses of the System's base error.
7. **Dedicated unit test** (`tests/unit/<service>.test.js`) using fakes for repositories/storage.

- **Check**: `npm run gate` (`R2`, `R8`, `R9`) + constructor fail-closed test + zero `supabase` imports in `*Service.js`.
- **Good** *(target pattern — illustrative)*:
  ```js
  /** @owns Enforces element reference quota and delegates cover selection. */
  export class ElementCoverService {
    constructor({ elementRepo, workflowSystem, logger = createLogger("element") }) {
      if (!elementRepo || !workflowSystem) throw new ElementConfigError("Missing required dependencies");
      this.elementRepo = elementRepo;
      this.workflowSystem = workflowSystem;
      this.logger = logger;
    }
  }
  ```
- **Bad**:
  ```js
  export class ElementCoverService {
    async update(id) {
      console.log("updating", id); // violates R2
      const { data } = await supabase.from("element").select("*").eq("id", id); // bypasses Repository
      if (this.workflow?.setCover) await this.workflow.setCover(id); // optional-dep shim
    }
  }
  ```

---

### Rule 8 — System-Prefixed Error Hierarchy & HTTP Mapping

Each System defines one base error class (`<System>Error`) and System-prefixed subclasses (e.g., `MediaValidationError`, `MediaNotFoundError`, `ModelsSystemError` — never generic unprefixed `ValidationError` that collides across Systems). A System's public capabilities throw **only** subclasses of `<System>Error`. Controllers map them to HTTP (`safePublicRouteError` in `src/utils/safePublicRouteError.js`), returning `404` for cross-tenant/missing IDs and masking `5xx` details as `INTERNAL_ERROR`.

> *Transitional note*: Locked ADR-0012 error names (`ValidationError`, `UploadError`, `QuotaError` in `src/platform/media-ingestion/MediaUploadErrors.js`) remain unchanged until an explicitly approved contract migration ticket.

- **Check**: Every `throw` reachable from a System's `index.js` produces an `instanceof <System>Error` with `code`, `statusCode`, and safe message metadata; zero raw PostgREST/Supabase errors escape to controllers.
- **Good** *(target pattern — illustrative)*:
  ```js
  export class MediaError extends AppError {}
  export class MediaValidationError extends MediaError {
    constructor(message, context) {
      super("MEDIA_VALIDATION_ERROR", message, { category: "USER_FAULT", statusCode: 400, context });
    }
  }
  ```
- **Bad**:
  ```js
  // Three different modules exporting colliding `ValidationError`, or throwing bare Error / raw PostgREST error
  const { data, error } = await supabase.from("media").select("*").eq("id", id);
  if (error) throw error; // leaks table/constraint internals to caller
  ```

---

### Rule 9 — Cross-System Orchestration Belongs to the Application Layer

Multi-System workflows (e.g., validate model -> reserve billing hold -> create media placeholder -> enqueue BullMQ job -> settle or release hold) live exclusively in the **Application / Execution Engine** (`UseCaseService`, `useCaseRunner`, V2 `workflowRunner`), never inside a Domain or Foundation System. Systems never re-implement another System's logic or rules.

- **Check**: No Business System coordinates >= 2 peer/upper Systems for a multi-step workflow or duplicates pricing, quota, or ownership formulas owned elsewhere.
- **Good**: `UseCaseService.prepareAndEnqueue` (`src/services/useCaseService.js:67-161`) is an Application coordinator: it reserves credits via `billingRuntime.reserveUseCase`, enqueues, and on dispatch failure calls `billingRuntime.rollbackUseCase`.
- **Bad**: A Domain System holding injected references to peer/upper coordinators — e.g. `CharacterService` receives `workflowService` and `useCaseService` (`src/container.js:233-239`) — or a System re-computing credit costs outside `Models`/`Billing`. (Whether `CharacterService` actually runs multi-System flows is UNVERIFIED.)

---

### Rule 10 — Async Execution, Idempotency & Compensation

1. **Queue long work**: AI provider calls, media processing pipelines, and sweeps run via BullMQ workers (`src/workers/`, `src/v2/queue/`), never inside synchronous HTTP request lifecycles.
2. **Idempotency**: Every worker handler and mutating capability accepts a deterministic key (`referenceId`, `runId`, `(workflow_id, media_id, role)`) so retries and duplicate deliveries are safe no-ops (`commitHoldIdempotent`, `rollbackHoldIdempotent`).
3. **Explicit compensation**: Partial failures across storage, DB, and billing unwind in strict reverse order with positive confirmation (`=== true`, ratchet `R7`; see ADR-0012 4-step rollback). Never rely on implicit DB cascades for cross-resource cleanup.
4. **Decoupled cleanup notifications**: Prefer structured in-process events or queued cleanup jobs over synchronous cross-System callbacks for post-commit side effects.

- **Check**: Every multi-resource write has a test proving partial failure restores prior state, checks `complete === true` before parent deletion, and produces identical state when called twice with the same idempotency key.
- **Good**: ADR-0012 rollback order (`unlink workflow_media -> restore/clear primary -> delete newly created media row -> mediaUploadService.discard(storageKeys)`), deleting a newly created container workflow **only** when `rollbackResult.complete === true`.
- **Bad**: Deleting a parent workflow when `rollbackResult.ok !== false` (`R7` violation), or holding credits without an idempotent rollback path when queue admission fails.

---

### Rule 11 — Explicit Tenancy & Billing Context

Tenant identity (`userId`, `projectId`) and billing reservation context (`referenceId` / reservation token, `planIdentity`) are passed **explicitly** in capability parameters across HTTP -> Application -> System -> Queue payload (`_context`) -> Worker. `AsyncLocalStorage` (`runWithContext` in `src/infrastructure/logging/index.js`) is strictly for log correlation — never read it for authorization, query scoping, or billing. Cross-tenant access always returns `404` (`NOT_FOUND`), never `403`.

- **Check**: Zero calls to `getContext()` outside `src/infrastructure/logging/`; every tenant-scoped capability requires `ctx.userId` (from verified JWT) and scopes queries by `(userId, projectId)`.
- **Good**:
  ```js
  await elementSystem.getElement({ elementId }, { userId: req.user.id, projectId: req.params.projectId });
  ```
- **Bad**:
  ```js
  // Reading userId from AsyncLocalStorage or req.body, or returning 403 revealing resource existence
  const { userId } = getContext();
  if (row.user_id !== req.body.userId) throw new ForbiddenError("403 Access denied");
  ```

---

### Rule 12 — Thin Controllers, Coordinating Application Layer, Domain-Rich Systems

- **Controllers (`controllers/`, `routes/`)**: Parse/validate HTTP transport parameters, extract `req.user.id`, call **one** Application coordinator or System Public Capability, and map the response/error to HTTP. Zero business logic, zero DB calls (`R1`), zero ownership queries.
- **Application Layer (`src/use-cases/`, `src/v2/`, `UseCaseService`)**: Coordinates cross-System execution plans, holds/settlements, and async workers; zero entity invariants.
- **Business Systems**: Own all domain rules, state transitions, quotas, ownership checks, and persistence.

- **Check**: Every controller action contains at most 1 call to an Application service or System capability and 0 repository/Supabase/multi-service calls.
- **Good**:
  ```js
  export const createElement = asyncHandler(async (req, res) => {
    const dto = await elementSystem.createElement(req.body, { userId: req.user.id });
    res.status(201).json(dto);
  });
  ```
- **Bad**: Controller querying `supabase.from("project")`, checking credit balances, calling `storageService.upload`, and inserting into `workflow` inline.

---

### Rule 13 — Public Surface Contract Testing

Every Business System must maintain automated **Contract Tests** (`tests/unit/<system>Contract.test.js` or `tests/boundary/<system>Contract.test.js`) that import **only** the System's public `index.js` alias. Contract tests wire real Internal Services over **fakes** for external I/O boundaries (fake repository/in-memory adapter, `InMemoryStorageProvider`) — never mocking the System's internal services — and verify:
1. Happy path contract output shape.
2. Boundary input rejections (Ajv schema, wrong user/project -> `404`, quota exceeded).
3. Partial-failure compensation and positive confirmation (`=== true`).
4. Idempotency under duplicate invocation.

Container graph sharing is verified in `tests/boundary/containerWiringBoundary.test.js`; Postgres lock/RPC invariants are verified via `node scripts/run-disposable-shared-media-test.js`.

- **Check**: Contract test file imports zero internal paths from the System and passes `npm test` hermetically.
- **Good**: `tests/unit/mediaServiceContract.test.js` loads the Media barrel (`src/platform/media/index.js`, lines 116-118) and uses an in-memory repo fake (lines 26-90) instead of a real DB. (It also imports `MediaRepository` directly at line 9, which a strict contract test would avoid.)
- **Bad**: Mocking private helper methods (`sinon.stub(service, "_validate")`) or asserting internal SQL string formatting instead of observable capability outcomes.

---

### Rule 14 — Mechanical Ratchet & AST Boundary Enforcement

Architectural boundaries are enforced in `npm run gate` (`apiOpenArt/scripts/gate.cjs`). The violation baseline (`apiOpenArt/arch-baseline.json`) is strictly monotonic non-increasing: counts may **only go down** via `node scripts/arch-check.cjs --shrink-baseline` and may never be raised or hand-edited (`AGENTS.md`). Regex checks (`R1`–`R9`) are complemented by the proposed AST boundary checks documented in `docs/architecture/ENFORCEMENT_PROPOSAL.md`.

- **Check**: `cd apiOpenArt && npm run gate` passes with `0` new violations and `arch-baseline.json` has zero increased keys relative to `HEAD`.
- **Good**: Eliminating direct `process.env` reads in a refactored System and running `node scripts/arch-check.cjs --shrink-baseline` to lock the lower count.
- **Bad**: Editing `arch-baseline.json` by hand to accommodate a new cross-System import or `--no-verify` on commit.

---

### Rule 15 — Phased Change Process

Every System refactoring or creation follows this exact sequence — **never skip a gate**:

1. **Audit (Read-Only)**: Document `Current State` (with verified `file:line` citations, or `UNVERIFIED`), `Target State`, `Gaps`, module classifications (`KEEP | REFACTOR | SPLIT | REBUILD | MERGE`), and `Open Decisions`.
2. **Proposal**: Author `docs/architecture/systems/<system>/SYSTEM.md` from `docs/architecture/systems/_TEMPLATE.md` and define small, isolated phases.
3. **Explicit Approval**: **STOP** and wait for human sign-off on Open Decisions and **one** phase.
4. **Implement ONE Phase (Test-First)**: Write characterization tests (for existing behavior) and failing contract/unit tests first, then apply minimal in-place code diffs. Keep all unrelated cleanup out of scope.
5. **Verify Contracts**: Run System contract tests and `tests/boundary/containerWiringBoundary.test.js`.
6. **Run Gates**: Run `cd apiOpenArt && npm run gate` (plus `--shrink-baseline` when violations drop) and record the `GATE SUMMARY` output.
7. **Review Full Diff & Stop**: Inspect `git status` and full `git diff` against phase scope; run two-axis review (Standards + Spec). **Never commit without explicit human approval.**

- **Check**: Every phase PR/diff maps 1:1 to an approved `SYSTEM.md` phase, touches zero out-of-scope files, and includes verbatim `GATE SUMMARY` output.
- **Good**: Auditing Media System boundaries, getting approval for Phase 1 (`index.js` contract + error hierarchy), implementing only Phase 1 test-first, running `npm run gate`, and stopping with full diff review.
- **Bad**: Combining System folder moves, error renames across three domains, and Opportunistic Workflow cleanup in a single unapproved coding session.

### Verification Rigor & Documentation Integrity
- **Verbatim Excerpts**: Every `file:line` citation in architecture documentation and audit reports must be accompanied by a verbatim excerpt from code opened in that session. Claims without verbatim code quotes are marked `UNVERIFIED`.
- **SQL Schema Testing**: Every SQL column or view attribute referenced in production code must be checked against the database schema or migration files by an explicit test.

---

## Open Decisions (Require Human Approval — Do Not Decide Unilaterally)

1. **Canonical System List & Physical Folder Layout**: Should Systems live under a unified `apiOpenArt/src/systems/<system>/index.js` (`#systems/<system>`) or keep `#platform/<name>` / `#domain/<name>` collapsed to single-file aliases (e.g. `#media`, `#storage`, `#billing`, `#models`, `#workflow`, `#project`, `#character`, `#element`)?
2. **`MediaUploadService` Home (`src/platform/media-ingestion/`)**: Under Rule 2 (owns tables + multiple consumers), `MediaUploadService` owns zero DB tables (by locked ADR-0012 design) while serving multiple Systems (`Element`, `Character`, `AssetUpload`, `WorkflowMedia`). Should it remain a standalone stateless Foundation pipeline module (`#media-ingestion`), or live as a sub-capability of `Storage` or `Media`?
3. **Error Prefix Migration vs Locked ADR-0012**: `MediaUploadErrors.js` (`ValidationError`, `UploadError`, `QuotaError`), `src/errors/AppError.js` (`ValidationError`), and `src/models/errors/index.js` (`ValidationError`) currently collide on generic `ValidationError`, and `docs/agents/rules/media-upload.md` locks ADR-0012 error names during the active upload refactor. When should ADR-0012 errors be prefixed (e.g. `MediaUploadValidationError`) or re-exported as aliases?
4. **Boundary Schema Validator (`ajv` vs existing `zod` in HTTP Controllers)**: Rule 4 mandates `ajv` (`apiOpenArt/package.json` includes `ajv` `^8.20.0`, currently 0 imports in `src/`). `zod` is imported in `controllers/adminController.js:1`, `controllers/walletController.js:1`, and `src/v2/api/v2ApiSchemas.js:1`; `controllers/v2/workflowsController.js:8,135` uses `postRunRequestSchema` from that module. Should HTTP controllers migrate to `ajv` or keep `zod` at the HTTP edge while Systems enforce `ajv` at `index.js`?
5. **Cross-System Read Models (`ProjectReadService` & `GenerationService`)**: `ProjectReadService.getProjectData` (`src/domain/project/ProjectReadService.js`) reads `project` (:55-58), `workflow` (:99), `media` (:111-118), `element` (:150-157), `characters` (:163-170), and `workflow_media` (:176-185) — including direct `supabase.from(...)` fallbacks — to build the ADR-0003 `Project Cache` payload. Confirm whether `ProjectReadService` is blessed as an explicit **Documented Read Model** under Rule 5, and which System/Application module owns it.
6. **Billing Table Split (`PricingService` vs `Models` Retail Pricing)**: Both `src/platform/billing/PricingService.js` (`public.pricing_rules`) and `src/models/index.js` (`calculateCost` / `estimatePrice` over model manifests) compute credit prices. Which System is the single authoritative owner of credit pricing?
7. **Fate of V2 Infrastructure Gateways (`src/infrastructure/*Gateway.js`)**: Once `Billing`, `Media`/`Workflow`, and `Platform` queues expose clean System contracts, should `WorkflowBillingGateway`, `WorkflowStorageGateway`, `WorkflowQueueGateway`, and `WorkflowEventRecorder` be retired in favor of calling System `index.js` contracts directly from the V2 Execution Engine?
