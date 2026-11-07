# Billing System (`billing.md`)

> **Audit Status**: Phase 1 Audit Complete (Awaiting Explicit Human Approval).
> **Governing Specifications**: [BUSINESS_SYSTEMS_RULES.md](../BUSINESS_SYSTEMS_RULES.md), [_TEMPLATE.md](_TEMPLATE.md), [AGENTS.md](../../../AGENTS.md), [GLOSSARY.md](../../../GLOSSARY.md).

| Metadata | Value |
|---|---|
| **System Name** | Billing |
| **Tier** | `Foundation` |
| **Public Import Alias** | `#platform/billing` *(Target: mapped to `./src/platform/billing/index.js` without wildcard)* |
| **Entry File** | `apiOpenArt/src/platform/billing/index.js` *(Target: to be created)* |
| **Base Error Class** | `BillingError` *(Proposed)* |
| **Audit Classification** | `REFACTOR` + `SPLIT/MERGE DECISION` *(Encapsulate private repositories, eliminate direct Supabase client instantiation, unify error hierarchy, and resolve pricing ownership with Models)* |
| **Phase Status** | Phase 2 Complete — All Refactoring Phases Verified & Closed |

---

## 1. Purpose

- **Business Responsibility**: Authoritative management of user credit balances, two-phase reservation lifecycle (`reserve` / `hold` -> `settle` / `commit` / `release` / `rollback`), hold TTL extensions and stale hold expiration, idempotent credit transactions, failed operation audit & automated retry, zero-cost usage audit (`usage_events`), and credit pack purchases.
- **Qualification Proof (Rule 2)**:
  - **Persistent State Owned**:
    - `public.wallets` (user balances, currency, timestamps)
    - `public.transactions` (two-phase credit holds, debits, credits, statuses: `PENDING`, `COMPLETED`, `FAILED`)
    - `public.failed_wallet_operations` (dead-letter queue for background replay)
    - `public.usage_events` (audit log for free/zero-credit executions)
    - `public.credit_packages` (credit pack pricing and Lemon Squeezy variants)
    - `public.pricing_rules` *(Subject to Open Decision OD-BILL-1)*
  - **External Consumers (>= 2)**:
    1. **Application / Execution Coordinators**: `UseCaseService` (`src/services/useCaseService.js:109-158`), `UseCaseBillingRuntime` (`src/v2/runtime/useCaseBillingRuntime.js:29-145`), and `WorkflowBillingGateway` (`src/infrastructure/billing/workflowBillingGateway.js:1-72`).
    2. **HTTP Controllers & Routes**: `walletController.js` (`controllers/walletController.js:57-188`, via `routes/wallet.js:16-32`), `adminController.js` (`controllers/adminController.js:242`), `paymentsController.js` (`controllers/paymentsController.js:19-204`, via `routes/payments.js`).
    3. **Background Workers**: `walletWorker.js` (`src/workers/walletWorker.js:47-270`), `reservationReaperWorker.js` (`src/workers/reservationReaperWorker.js:13-68`).
    4. **Container Wiring & Tests**: `src/container.js:140-166`, `tests/boundary/atomicWalletHoldRPCsBoundary.test.js`, `tests/integration/atomicWalletHoldPostgres.integration.test.js`.
- **Explicit Non-Goals**:
  - Does **not** compute AI provider wholesale costs or parse model manifests (`Models` system owns provider cost calculation via `src/models/pricing/pricingEngine.js`).
  - Does **not** execute multi-system workflow pipelines or decide when to fail media items (`UseCaseService` and Application workers own orchestration; see Rule 9).
  - Does **not** manage workflow state, media placeholders, or storage binaries (`Workflow`, `Media`, and `Storage` systems own those resources).

---

## 2. Owns (Tables, Resources & Constants)

### Owned Database Tables & SQL RPCs (Rule 5)

| Postgres Table / RPC | Repository (`private`) | Key Invariants / Constraints | Current Direct Callers (`file:line`) |
|---|---|---|---|
| `public.wallets` | `WalletRepository.js` *(Target)* | `user_id UNIQUE`, `balance >= 0`, updated only via atomic SQL RPCs or repository | `WalletService.js:48, 57`, `walletWorker.js:243` |
| `public.transactions` | `TransactionRepository.js` *(Target)* | `reference_id UNIQUE`, status enum (`PENDING`, `COMPLETED`, `FAILED`), 10-minute hold TTL | `WalletService.js:220, 269, 417, 477, 600`, `walletWorker.js:254` |
| `public.failed_wallet_operations` | `FailedOpsRepository.js` *(Target)* | `(reference_id, operation_type) UNIQUE`, exponential backoff retry up to 5 attempts | `FailedOpsService.js:42, 59, 107, 128, 149` |
| `public.usage_events` | `UsageEventRepository.js` (`src/platform/billing/UsageEventRepository.js:20`) | `reference_id UNIQUE`, non-financial audit trail for zero-credit executions | `UsageEventRepository.js:41, 65, 76, 88`, `WalletService.js:116, 157, 185` |
| `public.credit_packages` | `CreditPackageRepository.js` *(Target)* | Package definitions, variant IDs, credit grants, checkout URLs | `controllers/paymentsController.js:56, 170, 181`, `paymentsUtils.js:28` |
| `rpc: hold_credits` | `TransactionRepository.js` | Atomic balance debit + transaction record creation with hold expiry | `WalletService.js:225, 273` |
| `rpc: extend_hold` | `TransactionRepository.js` | Extends `expires_at` on an active `PENDING` transaction | `WalletService.js:361` |
| `rpc: credit_wallet` | `WalletRepository.js` | Atomic balance increment + completed credit transaction record | `WalletService.js:420` |
| `rpc: expire_stale_holds` | `TransactionRepository.js` | Finds expired `PENDING` holds, marks `FAILED`, refunds balances | `WalletService.js:516, 539` |

> *Note on `public.pricing_rules`*: Transferred to `Models` system ownership under approved decision **OD-BILL-1**. `PricingService` relocated to `src/models/pricing/PricingService.js`.

### Owned Domain Entities, Policies & Quotas

| Entity / Constant | Source (`file:line`) | Description |
|---|---|---|
| `HOLD_TTL_SECONDS` | `src/platform/billing/WalletService.js:16` | 10 minutes (600 seconds) default hold reservation expiration |
| `METADATA_MAX_BYTES` | `src/platform/billing/WalletService.js:17` | 4096 bytes maximum JSON size for transaction audit payload |
| `DEFAULT_INITIAL_BALANCE` | `src/platform/billing/WalletService.js:30-34` | Configurable starting balance for new wallets (env: `INITIAL_WALLET_BALANCE`) |
| `RETRY_BACKOFF_SCHEDULE` | `src/platform/billing/FailedOpsService.js:12-18` | `NOW() + 1m * 2^retry_count`, max 5 retries before `ABANDONED` |

### Known Concerns & Domain Boundaries

1. **Dual Pricing Ownership Conflict (Mandatory Scope Item)**:
   > **Current Code Reality**:
   > - `src/platform/billing/PricingService.js:57-93`: Queries table `public.pricing_rules` (PostgreSQL) with Redis cache acceleration for `(modelKey, operationType, qualityTier)`. Used by `GET /api/wallet/price` (`walletController.js:158`) and `adminController.js:242`.
   > - `src/models/index.js` & `src/models/pricing/pricingEngine.js:17-120`: Manifest-based pricing calculation. Model definitions carry static `retailPricing` metadata in JSON manifests.
   > - `src/domain/project/ProjectReadService.js:9-18`: Defines `getCatalogPricing()` which reads directly from `getCatalog()` in `src/models/index.js` and embeds retail prices into the client `Project Cache` payload (`APP_CONFIG.pricing`).
   > - `src/use-cases/workflowBillingPlan.js:1-98`: Calculates workflow execution costs by importing `calculateCost` from `src/models/index.js`.
   >
   > **Conflict**: Two competing sources of truth for credit pricing exist simultaneously. One in `Billing` (`pricing_rules` table), one in `Models` (manifests + `pricingEngine.js`). The single authoritative owner must be decided (**OD-BILL-1**).

2. **Cross-System Orchestration in Reservation Reaper**:
   - `src/workers/reservationReaperWorker.js:18-46` imports `walletService` and `mediaWorkflowLifecycleService`, mixing hold reaping with media status failure. Under Rule 9, the Billing system must expose atomic hold release/reap capabilities, while the multi-system reconciliation workflow belongs to the Application coordinator.

3. **Direct Database Client & Missing Repositories**:
   - `WalletService.js:28-29` and `FailedOpsService.js:27-28` instantiate their own `@supabase/supabase-js` clients directly from constructor strings (`supabaseUrl`, `supabaseServiceKey`), violating Rule 7.
   - Five tables (`wallets`, `transactions`, `failed_wallet_operations`, `pricing_rules`, `credit_packages`) are queried directly via `.from(...)` without encapsulating repositories, violating Rule 5.

---

## 3. Public Capabilities (Proposed Target Surface)

Exported **exclusively** from `apiOpenArt/src/platform/billing/index.js` (Rules 3, 4, 11). Standalone verb-noun capabilities wrapping private services and repositories.

### Summary Table

| Capability (`verbNoun`) | Mode | Input `@typedef` + Validator | Output `@typedef` | Thrown Errors (`Billing*Error`) | Auth & Tenancy (`ctx`) |
|---|---|---|---|---|---|
| `reserveCredits` | `Async` | `ReserveCreditsInput` (`billingReserveSchema`) | `BillingReservationDto` | `BillingValidationError`, `BillingInsufficientFundsError`, `BillingConflictError` | `ctx.userId` required |
| `settleCredits` | `Async` | `SettleCreditsInput` (`billingSettleSchema`) | `BillingSettlementDto` | `BillingValidationError`, `BillingNotFoundError` | `ctx.userId` verified |
| `rollbackCredits` | `Async` | `RollbackCreditsInput` (`billingRollbackSchema`) | `BillingRollbackDto` | `BillingValidationError`, `BillingNotFoundError` | `ctx.userId` verified |
| `extendCreditHold` | `Async` | `ExtendHoldInput` (`billingExtendSchema`) | `BillingHoldDto` | `BillingValidationError`, `BillingNotFoundError` | Internal / Coordinator |
| `getCreditBalance` | `Async` | `GetBalanceInput` | `BillingBalanceDto` | `BillingNotFoundError` | `ctx.userId` required |
| `listTransactions` | `Async` | `ListTransactionsInput` | `BillingTransactionsDto` | `BillingValidationError` | `ctx.userId` required |
| `creditUserWallet` | `Async` | `CreditWalletInput` | `BillingTransactionDto` | `BillingValidationError` | Admin / Webhook (`referenceId` idempotent) |
| `reapExpiredCreditHolds` | `Async` | `ReapHoldsInput` | `BillingReapResultDto` | `BillingError` | Background Worker / System only |
| `recordFailedOperation` | `Async` | `FailedOpInput` | `void` | *None* (fail-safe) | Internal / Worker |

### Capability Contracts (Illustrative Target)

#### `reserveCredits(input, ctx)`
- **Input (`@typedef`)**:
  ```js
  /**
   * @typedef {Object} ReserveCreditsInput
   * @property {number} amount - Non-negative integer credit amount to hold.
   * @property {string} referenceId - Deterministic idempotency key (e.g., "usecase:<id>:<user>:<runId>").
   * @property {Object} [metadata] - Compact execution context (< 4096 bytes).
   */
  ```
- **Context (`ctx`)**: `{ userId: string, requestId?: string }`
- **Output (`@typedef`)**:
  ```js
  /**
   * @typedef {Object} BillingReservationDto
   * @property {'NO_CHARGE' | 'CHARGEABLE'} kind
   * @property {'ACTIVE' | 'HELD'} status
   * @property {string} referenceId
   * @property {number} amount
   * @property {string|null} transactionId
   * @property {string} expiresAt
   */
  ```
- **Errors**: `BillingValidationError` (400), `BillingInsufficientFundsError` (402), `BillingConflictError` (409).
- **Idempotency**: Re-invoking with identical `referenceId` returns the existing reservation without duplicate debit.

---

## 4. Internal Components (Private)

Private to `src/platform/billing/` (Rule 7):

| Component | File (`file:line`) | `@owns` Statement | Constructor Dependencies |
|---|---|---|---|
| `WalletService` | `src/platform/billing/WalletService.js:15` | Two-phase credit reservation, balance enforcement, and transaction coordination. | `{ walletRepo, txRepo, usageEventRepo, logger }` |
| `WalletRepository` | `src/platform/billing/repositories/WalletRepository.js` *(Target)* | Persistence and SQL RPC execution for `public.wallets`. | `{ supabaseClient }` |
| `TransactionRepository` | `src/platform/billing/repositories/TransactionRepository.js` *(Target)* | Persistence and SQL RPC execution for `public.transactions`. | `{ supabaseClient }` |
| `FailedOpsService` | `src/platform/billing/FailedOpsService.js:26` | Dead-letter retry scheduling and backoff logic for failed wallet operations. | `{ failedOpsRepo, logger }` |
| `FailedOpsRepository` | `src/platform/billing/repositories/FailedOpsRepository.js` *(Target)* | Persistence for `public.failed_wallet_operations`. | `{ supabaseClient }` |
| `UsageEventRepository` | `src/platform/billing/UsageEventRepository.js:20` | Audit trail persistence for `public.usage_events` (free tier). | `{ supabaseClient }` |
| `CreditPackageRepository` | `src/platform/billing/repositories/CreditPackageRepository.js` *(Target)* | Persistence for `public.credit_packages`. | `{ supabaseClient }` |
| `PricingService` | `src/platform/billing/PricingService.js:22` *(Subject to OD-BILL-1)* | PostgreSQL rate card lookup and Redis caching for model pricing rules. | `{ pricingRepo, redis, logger }` |
| `PricingRuleRepository` | `src/platform/billing/repositories/PricingRuleRepository.js` *(Target)* | Persistence for `public.pricing_rules`. | `{ supabaseClient }` |

---

## 5. Allowed Dependencies

Dependencies point strictly downward (Rule 6):

| Target | Kind | Import Specifier | Reason |
|---|---|---|---|
| `Logging` | `Platform` | `src/infrastructure/logging/index.js` | Structured logger via `createLogger("billing")` |
| `Redis` | `Platform` | `#queue/redis.js` (`redisConnection`) | Cache acceleration for pricing rules (if retained in Billing) |
| `Supabase Client Factory` | `Platform Infrastructure` | `@supabase/supabase-js` / `lib/supabase.js` | Initialized at container level and injected into Repositories |

---

## 6. Forbidden Dependencies

Explicitly prohibited imports and runtime couplings for Billing (Rules 3, 5, 6, 9):

- **Upper Domain & Media Systems**: Zero imports of `src/domain/character/`, `src/domain/element/`, `src/domain/generation/`, `src/platform/media/`, `src/platform/workflow/`, `src/services/useCaseService.js`, or `src/v2/`.
- **Foreign Persistence**: Zero queries to `public.media`, `public.workflow`, `public.project`, or `public.characters`.
- **Direct Database Client in Services**: `WalletService` and `FailedOpsService` must not instantiate `new createClient()`; all DB access goes through private Repositories.
- **Deep Internals from Outside**: No caller outside `src/platform/billing/` may import internal files (`WalletService.js`, `UsageEventRepository.js`, etc.).
- **Wildcard Alias**: `package.json` must not retain `"#platform/billing/*.js"`.

---

## 7. Error Classes

All public errors extend `BillingError` with a `Billing` prefix (Rule 8):

| Error Class | `code` | `statusCode` | `retryable` | Safe Public Message | When Thrown |
|---|---|---|---|---|---|
| `BillingError` | `BILLING_ERROR` | `500` | `false` | `"Internal billing error"` | Base class for all Billing system errors |
| `BillingValidationError` | `BILLING_VALIDATION_ERROR` | `400` | `false` | `<Field-safe message>` | Invalid amount, malformed referenceId, or Ajv schema failure |
| `BillingNotFoundError` | `NOT_FOUND` | `404` | `false` | `"Wallet not found"` | Missing wallet or cross-tenant query mismatch |
| `BillingInsufficientFundsError` | `INSUFFICIENT_FUNDS` | `402` | `false` | `"Insufficient credits for this operation"` | Wallet balance is less than required hold amount |
| `BillingConflictError` | `CONFLICT` | `409` | `false` | `"Transaction state conflict"` | Attempting invalid transition (e.g., settling an expired hold) |
| `BillingConfigurationError` | `BILLING_CONFIG_ERROR` | `500` | `false` | `"Billing service unconfigured"` | Missing Supabase configuration or required repository DI |

---

## 8. Current Status

- **Current Files & Locations**:
  - `src/platform/billing/WalletService.js` (1,041 lines)
  - `src/platform/billing/PricingService.js` (144 lines)
  - `src/platform/billing/FailedOpsService.js` (168 lines)
  - `src/platform/billing/UsageEventRepository.js` (117 lines)
  - `src/services/walletService.js` (131 lines, in-memory duplicate)
  - `src/infrastructure/billing/workflowBillingGateway.js` (73 lines)
- **Container Wiring (`apiOpenArt/src/container.js`)**:
  - `src/container.js:5-7`: Deep imports `WalletService`, `PricingService`, `FailedOpsService`.
  - `src/container.js:45`: Deep import `UsageEventRepository`.
  - `src/container.js:140-142`: Instantiates `WalletService(process.env.SUPABASE_URL, walletServiceKey, { usageEventRepo })`.
  - `src/container.js:154`: Instantiates `PricingService(_supabaseForPricing, redisConnection)`.
  - `src/container.js:165`: Instantiates `FailedOpsService(process.env.SUPABASE_URL, walletServiceKey)`.
  - `src/container.js:190`: Instantiates `WorkflowBillingGateway({ walletService })`.
  - `src/container.js:204`: Injects `walletService` and `pricingService` into `UseCaseService`.
- **`package.json` `"imports"` Entry**:
  - `"#platform/billing/*.js": "./src/platform/billing/*.js"` (Wildcard, violates Rule 3).
- **Existing Tests**:
  - `tests/boundary/atomicWalletHoldRPCsBoundary.test.js`
  - `tests/boundary/compactBillingMetadataBoundary.test.js`
  - `tests/boundary/elementAnalysisBillingBoundary.test.js`
  - `tests/boundary/orchestrationFailureBillingBoundary.test.js`
  - `tests/boundary/serverContextFailClosedAndBillingReleaseBoundary.test.js`
  - `tests/boundary/walletMisconfigurationBoundary.test.js`
  - `tests/boundary/walletWorkerReaperReconciliationBoundary.test.js`
  - `tests/integration/atomicWalletHoldPostgres.integration.test.js`
  - `tests/integration/atomicWalletHoldIdempotentPostgres.integration.test.js` (UNVERIFIED: real PostgreSQL execution pending Docker availability on host)
  - `tests/unit/profilesCreditsDeprecation.test.js`
  - `tests/unit/walletServiceIdempotency.test.js`

---

## 9. Known Gaps

| ID | Rule Violated | Location (`file:line`) | Current Behavior | Target Fix | Planned Phase |
|---|---|---|---|---|---|
| `G1` | `Rule 3` | `package.json:16` | Wildcard import `"#platform/billing/*.js"` allows unencapsulated deep imports. | Replace with single exact alias `#platform/billing` -> `./src/platform/billing/index.js`. | Phase 2.1 |
| `G2` | `Rule 3` | `src/platform/billing/` | Missing single entry point `index.js`. External callers import internal files directly. | Create `src/platform/billing/index.js` exporting public capabilities and errors. | Phase 2.1 |
| `G3` | `Rule 5, 7` | `WalletService.js:28-29, 48, 220` | `WalletService` creates Supabase client internally and executes direct SQL queries on `wallets` and `transactions`. | Extract `WalletRepository` and `TransactionRepository`; inject into `WalletService`. | Phase 2.2 |
| `G4` | `Rule 5, 7` | `FailedOpsService.js:27-28, 42, 59` | `FailedOpsService` creates Supabase client internally and executes direct SQL queries on `failed_wallet_operations`. | Extract `FailedOpsRepository`; inject into `FailedOpsService`. | Phase 2.2 |
| `G5` | `Rule 5` | `controllers/paymentsController.js:56, 170` | Controller directly queries `public.credit_packages` via `supabase.from("credit_packages")`. | Resolved in Phase 2.4: `credit_packages` queries encapsulated in `CreditPackageRepository` and Billing capabilities. | Phase 2.4 |
| `G6` | `Rule 8` | `WalletService.js:7-13` | Custom `WalletError` does not extend `AppError`, lacks `Billing` prefix, and uses non-standard codes. | Create `BillingErrors.js` hierarchy inheriting `AppError`. | Phase 2.1 |
| `G7` | `Rule 5, 9` | `PricingService.js` vs `src/models/` | Dual pricing source of truth: `pricing_rules` table in Billing vs model manifests in Models. | Resolved in Phase 2.3: `PricingService` relocated to `src/models/pricing/`, removed from Billing barrel. | Phase 2.3 |
| `G8` | `Rule 9` | `reservationReaperWorker.js:26-46` | Sweeper worker mixes Billing hold release with Media placeholder updates. | Resolved in Phase 2.5: Billing owns `reapExpiredHolds()`; worker coordinates media lifecycle in Application layer. | Phase 2.5 |
| `G9` | `Rule 7` | `src/services/walletService.js:8-130` | Redundant in-memory wallet service duplicates reservation logic with ad-hoc mutations. | Resolved in Phase 2.5: Annotated with `@owns` header as in-memory test double; baseline ratcheted. | Phase 2.5 |
| `G10` | `Rule 7` | `WalletService.js`, `PricingService.js`, `FailedOpsService.js` | Missing `@owns` headers required by ratchet `R9`. | Add top-of-file `@owns` headers to each service. | Phase 2.1 |
| `G11` | `Rule 2, 8` | `FailedOpsService.js:73, 92` | When `repo.insertFailedOp` fails or throws an exception, `record()` logs at error level but omits `amount` and `userId` from the log context, and swallows the error without external alerting or DLQ fallback. | Add `amount` and `userId` to structured error log payloads; emit an alert event if recording fails. | Backlog |
| `G12` | `Rule 2, 8` | `FailedOpsService.js:135`, `walletWorker.js:137` | No external alerting mechanism (Slack, PagerDuty, Sentry) is wired when an operation transitions to `ABANDONED`. Only local structured JSON logs are emitted (`alert: MANUAL_INTERVENTION_REQUIRED`). UNVERIFIED whether a log-based alert exists outside the repository. | Wire an alert dispatcher or dead-letter queue notification on terminal abandonment. | Backlog |
| `G13` | `Rule 8` | `src/platform/billing/index.js:284`, `controllers/paymentsController.js:34` | When `CreditPackageRepository` is missing/null, `listCreditPackages()` returns `[]` and `getCreditPackages` returns HTTP 200 OK `{ ok: true, data: [] }` rather than failing closed with 500 or alerting on configuration error. | Throw `BillingConfigurationError` when unconfigured or add fallback healthcheck alert. | Backlog |
| `G14` | `Rule 8` | `src/platform/billing/FailedOpsService.js:45` | When `this.repo` is null/unconfigured, `FailedOpsService.record()` returns silently (`if (!this.repo) return;`) with zero logging or alert, masking complete loss of failed operation recording. | Emit structured warning log or throw `BillingConfigurationError`. | Backlog |
| `G15` | `Rule 1, 2` | `WalletService.js:427, 653, 695, 778` | Table fallbacks (`holdFallback`, `creditFallback`, `rollbackFallback`) are reachable ONLY on PGRST202 or PostgREST "schema cache" error. They execute in two separate database calls without transaction atomicity. If process dies between transaction insert and balance increment/decrement, a replayed webhook/worker returns HTTP 200 OK ("Already processed") while wallet balance was never adjusted (unrecoverable financial drift). | Resolved: Removed non-atomic fallbacks (`holdFallback`, `creditFallback`, `rollbackFallback`, `commitFallback`). `WalletService` fails closed with `BillingConfigurationError` on PGRST202. Verified in commits `e9e1e1a` (code) and `70e5017` (tests). | Closed |

---

## 10. Decisions (Approved by Human)

- [x] **OD-BILL-1 — Authoritative Owner of Credit Pricing**: **Approved (Option A)**. `Models` is the authoritative owner of both retail and wholesale generation pricing. `Billing` never calculates prices and does not know AI models or generation parameters; it manages only user balances and integer credit amounts.
- [x] **OD-BILL-2 — Payments Domain Scope (`credit_packages` & Checkout)**: **Approved (Option A)**. `credit_packages` remains within `Billing`. `Payments` handles external checkout/webhook integration and calls `Billing` to credit the wallet.
- [x] **OD-BILL-3 — Public Interface Architecture**: **Approved (Option A)**. `src/platform/billing/index.js` exports standalone verb-noun capability functions (`reserveCredits`, `settleCredits`, `rollbackCredits`, `getCreditBalance`, `addCredits`, `listTransactions`, `listCreditPackages`).
- [x] **OD-BILL-4 — Repository Extraction & IoC**: **Approved (Option A)**. Private repositories (`WalletRepository`, `TransactionRepository`, `FailedOpsRepository`, `CreditPackageRepository`) to be extracted progressively and injected at container level.
- [x] **OD-BILL-5 — Phase 2.1 Approval**: **Approved**. Surface and errors isolated, exact alias mapped in `package.json`, 18 contract tests passing. Commit `688eeb3`.
- [x] **OD-BILL-6 — Privilege Scoping for Payment Webhooks vs Catalog (`CreditPackageRepository`)**: **Not applicable today (service-role bypasses RLS)**.
  - **Context & Finding**: The backend exclusively uses the `service_role` key everywhere (both `supabase` and `supabaseAdmin` in `lib/supabase.js` share `SUPABASE_SERVICE_ROLE_KEY`), bypassing Postgres Row-Level Security entirely. Therefore, RLS policies like `"Public read active packages"` (`baseline.sql:1188`) are not enforced on backend queries. All repository queries execute under `service_role` privileges.
  - **Resolution**: `CreditPackageRepository` was refactored in commit `20f6f47` to require explicit constructor injection (`catalogClient`), eliminating runtime mutation in `container.js`.

---

## 11. Proposed Phased Implementation Plan

- **Phase 2.1 — Surface & Error Isolation**:
  - Create `src/platform/billing/BillingErrors.js` inheriting `AppError`.
  - Add `@owns` headers to `WalletService.js`, `PricingService.js`, `FailedOpsService.js`.
  - Create `src/platform/billing/index.js` and map exact alias `#platform/billing` in `package.json` (removing wildcard `*`).
  - Add contract test `tests/unit/billingContract.test.js`.
- **Phase 2.2 — Repository Extraction & Inversion of Control** *(Complete)*:
  - Extract `WalletRepository.js` and `TransactionRepository.js`.
  - Extract `FailedOpsRepository.js`.
  - Inject repositories into `WalletService` and `FailedOpsService` (remove internal `createClient` calls, wire in `container.js` via `billingFactory.js`).
  - Add repository isolation tests `tests/unit/billingRepositories.test.js`.
- **Phase 2.3 — Pricing Ownership Consolidation** *(Complete)*:
  - Confirmed `Models` as authoritative single owner of credit pricing (`calculateCost` in `src/models/index.js`).
  - Decoupled `PricingService` from Billing; relocated to `src/models/pricing/PricingService.js`.
  - Removed `PricingService` re-export from `src/platform/billing/index.js`.
  - Updated container wiring and test path references.
- **Phase 2.4 — Credit Packages & Payments Consolidation** *(Complete)*:
  - Created `CreditPackageRepository.js` encapsulating all `credit_packages` table access.
  - Injected `creditPackageRepo` into Billing system and wired in `src/container.js`.
  - Encapsulated checkout package queries and webhook credit resolution via Billing capabilities (`getCreditPackage`, `resolvePackageCredits`, `listCreditPackages`).
  - Purged all raw `.from("credit_packages")` queries from `paymentsController.js` and `paymentsUtils.js`.
- **Phase 2.5 — Worker & Gateway Cleanup** *(Complete)*:
  - Added `@owns` header to `src/services/walletService.js` (annotated as test double).
  - Ratcheted architecture baseline down (`arch-baseline.json`: 72 -> 71 entries).
  - Validated boundary segregation in `reservationReaperWorker.js` and `workflowBillingGateway.js`.

---

## 12. Accepted Technical Debt & Removal Conditions

| Item | Context & Rationale | Exact Removal Condition |
|---|---|---|
| **Mutable `.supabase` getter/setter on `WalletService` (Fix-Phase 6)** | Preserves backward compatibility with legacy boundary and unit tests that mutate `.supabase` directly on `walletService` instances post-construction instead of injecting repository test doubles at construction time. Exactly 15 test sites depend on this property: 14 occurrences in `tests/boundary/atomicWalletHoldRPCsBoundary.test.js` and 1 occurrence in `tests/unit/sheetGenerationWorkflowMediaRealService.test.js`. | Remove the getter/setter property on `WalletService` once all 15 test sites are refactored to pass repository doubles (`walletRepo`, `txRepo`) into `WalletService` / `createWalletService` at construction. |
| **CreditPackageRepository Construction Injection (Fix-Phase 1)** | Resolved in commit `20f6f47` by requiring `catalogClient` at constructor and removing the runtime `.supabase` mutation in `container.js`. | Closed. |
| **Dual Property Names `txRepo` vs `transactionRepo` (Technical Debt)** | The factory `createBillingRepositories` returns both `transactionRepo` and `txRepo`, and `WalletService` constructor / `createWalletService` accepts both names. Used in: `src/platform/billing/billingFactory.js:29, 42, 51, 56, 61`, `src/platform/billing/WalletService.js:26, 31, 40, 48, 62`, `docs/agents/service-catalog.md:27`, and `tests/unit/billingRepositories.test.js:471, 480`. Canonical name is `transactionRepo`. | Standardize `WalletService` internal references and constructor on `transactionRepo`, update service catalog, and remove `txRepo` alias from `billingFactory.js`. |
| **Package Field Allowlist vs Database Schema (Session Clarification)** | The earlier claim in a session review of a 13-column `credit_packages` schema was a session error; the database schema defines 10 columns (`id`, `name`, `credits`, `price_cents`, `currency`, `is_active`, `sort_order`, `metadata`, `created_at`, `updated_at`). Step 1a-2 was deferred, and Step 1a-3 (`bb14851`) converted `toPublicPackage` to an explicit field allowlist (`id`, `name`, `credits`, `price_cents`, `currency`). | Maintained via unit test `tests/unit/paymentsUtils.test.js`. |
| **Clean-Gate Isolation & Migration Paths (Technical Debt)** | Several unit tests resolve migration files via `path.resolve(__dirname, "../../../supabase/migrations")` outside `apiOpenArt`. To guarantee hermetic gating, `scripts/clean-gate.ps1` executes in an isolated `$env:TEMP` worktree and copies ONLY tracked migrations from root `HEAD`. | Eliminate relative `../../../` parent traversals in tests; point migrations to an in-tree test fixture or package-local mock. |
| **Postgres Concurrency Integration Test UNVERIFIED Status** | `tests/integration/atomicWalletHoldIdempotentPostgres.integration.test.js` tests concurrent hold races against real PostgreSQL RPCs. Marked UNVERIFIED because live PostgreSQL / Docker is not running in local test environment; test is conditionally skipped when `POSTGRES_INTEGRATION_URL` is unset. | Verify against a running Supabase/PostgreSQL instance in CI. |

---

## 13. Clean-Worktree Test Counts per Commit

| Commit | Summary | Files Changed | Clean Worktree Gate Count | Status |
|---|---|---|---|---|
| `0e800b2` | fix(billing): safe transaction status lookup with warning log during idempotency recovery | `WalletService.js` | 1254 pass, 0 fail | PASS |
| `20f6f47` | refactor(billing): wire catalogClient to CreditPackageRepository with constructor guard | `container.js`, `billingFactory.js`, `CreditPackageRepository.js`, `billingRepositories.test.js` | 1258 pass, 0 fail | PASS |
| `bb14851` | feat(payments): convert toPublicPackage to explicit field allowlist | `paymentsUtils.js`, `paymentsUtils.test.js` | 1262 pass, 0 fail | PASS |
| `c909721` | build(gate): add clean-gate script with isolated worktree execution | `scripts/clean-gate.ps1` | 1269 pass, 0 fail | PASS |
| `fd7d51d` | fix(queue): add error event listeners to jobQueue, useCaseQueue, and useCaseWorker | `queue.js`, `jobQueueService.js`, `useCaseWorker.js`, `queueErrorHandlers.test.js` | 1266 pass, 0 fail | PASS |
| `093ab0b` | test(billing): add hermetic idempotency contract and postgres concurrency integration tests | `walletServiceIdempotency.test.js`, `atomicWalletHoldIdempotentPostgres.integration.test.js` | 1273 pass, 0 fail | PASS |
| `e9e1e1a` | fix(billing): fail closed on missing RPCs and remove non-atomic table fallbacks | `WalletService.js`, `service-catalog.md` | 1272 pass, 1 fail (expected: old test called removed `rollbackFallback`) | PRE-TEST CODE |
| `70e5017` | test(billing): assert fail-closed on missing RPCs and HTTP 500 on webhook credit failure | `sheetGenerationWorkflowMediaRealService.test.js`, `paymentsWebhookBoundary.test.js` | 1274 pass, 0 fail | PASS |
