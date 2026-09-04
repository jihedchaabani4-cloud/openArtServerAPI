# Labveil Backend — System Architecture Master Document

## 1. High-Level Architectural Vision

The Labveil backend is structured into **Three Clear Tiers** adhering to Domain-Driven Design (DDD), Separation of Concerns, and Event-Driven Asynchronous Execution:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        1. PRODUCT & DOMAIN SYSTEMS                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │  Use Cases   │  │  Workflow Engine │  │  Models Management (V2)  │  │
│  └──────┬───────┘  └─────────▲────────┘  └────────────┬─────────────┘  │
│         │                    │                        │                │
│  ┌──────▼───────┐  ┌─────────┴────────┐  ┌────────────▼─────────────┐  │
│  │Billing/Wallet│  │   Media System   │  │    Prompt Intelligence   │  │
│  └──────────────┘  └──────────────────┘  └──────────────────────────┘  │
├────────────────────────────────────────────────────────────────────────┤
│                        2. RUNTIME SYSTEMS                              │
│  ┌────────────────────────────────────┐  ┌──────────────────────────┐  │
│  │   BullMQ Queue & Worker Pool       │  │ Error Policy & Recovery  │  │
│  │   (v2-workflow-jobs, Redis)        │  │ (Auto-Refund, Fallback)  │  │
│  └────────────────────────────────────┘  └──────────────────────────┘  │
├────────────────────────────────────────────────────────────────────────┤
│                   3. CROSS-CUTTING INFRASTRUCTURE                      │
│  ┌────────────────────────────────────┐  ┌──────────────────────────┐  │
│  │ Unified Logging & Tracing Engine   │  │ Database Repositories    │  │
│  │ (Pino, AsyncLocalStorage Context)  │  │ (Supabase Postgres)      │  │
│  ├────────────────────────────────────┤  ├──────────────────────────┤  │
│  │ CDN Storage (Supabase S3 Storage)  │  │ Security & Tenant Access │  │
│  └────────────────────────────────────┘  └──────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tier 1: Product & Domain Systems

### 1.1. Use Cases Layer (`src/use-cases/`, `src/services/useCaseService.js`)
* **Responsibility**: Declares **WHAT** business operation the user intends to perform.
* **Registered Use Cases**:
  - `image-generation-v1`: End-to-end prompt-to-image pipeline.
  - `character-sheet-v1`: Multi-view consistent character generation.
* **Flow**:
  1. Validates input schema.
  2. Calls `BillingSystem` for upfront credit check & hold creation (`createHold`).
  3. Enqueues job payload into BullMQ Redis queue.
  4. Returns immediately with `taskId` and placeholder identifiers.

### 1.2. V2 Composable Workflow Engine (`src/v2/`)
* **Responsibility**: Declares **HOW** the business operation is executed step-by-step.
* **Core Components**:
  - **`compileWorkflow.js`**: Compiles YAML workflows into a Directed Acyclic Graph (DAG) Execution Plan with edge dependencies and retry policies.
  - **`workflowRunner.js`**: Orchestrates graph execution, evaluates node dependencies, triggers execution, and detects terminal states or deadlocks.
  - **`nodeExecutor.js`**: Executes individual nodes in isolation, resolves bindings, manages intermediate persistence, and handles node-level retries.
  - **Nodes Catalog**: `promptBuilderNode`, `imageGenerationNode`, `llmNode`, `safetyService`.

### 1.3. Models Management System (`src/models/`)
* **Responsibility**: Sealed subsystem that defines models, catalogs, parameters, and pricing.
* **Strict 5-Function Public Interface**:
  ```javascript
  import { getCatalog, getSchema, validateInput, calculateCost, run } from "#models/index.js";
  ```
* **Distinction**: `Models System` calculates costs, validates inputs, and resolves deployments. The actual HTTP network dispatch is delegated to the **Provider System**.

### 1.4. External Provider System (`src/providers/`)
* **Responsibility**: Pure HTTP transport adapters for third-party AI APIs.
  - `wavespeed/client.js`: WaveSpeed API client with timeout and quota handling.
  - `google/client.js`: Google GenAI SDK integration for Gemini models.
  - `LLMService.js`: Unified LLM wrapper for prompts and metadata analysis.

### 1.5. Wallet & Billing System (`src/platform/billing/`)
* **Billing Sub-domain**:
  - `PricingService.js`: DB-backed pricing matrix cached in Redis. Answers: *"How many credits does this model and operation cost?"*.
  - `UsageEventRepository.js`: Immutable audit trail for every credit movement in `usage_events`.
* **Wallet Sub-domain**:
  - `WalletService.js`: Atomic operations on user balances (`createHold`, `commitHold`, `releaseHold`).
  - `Cron`: Background sweeper expiring abandoned/stale holds every 10 minutes.
  - `FailedOpsService.js`: Exponential backoff queue for retrying dropped financial operations.

### 1.6. Media & Storage Subsystem (`src/platform/media/`, `src/platform/storage/`)
* **Responsibility**: Manages media placeholders and final CDN storage.
  - Lifecycle: `placeholder (processing)` ➔ `generation` ➔ `stored (success)` or `failed`.
  - Storage: Supabase Storage bucket with public CDN URLs.

### 1.7. Prompt Intelligence Service (`src/platform/ai/PromptService.js`)
* **Responsibility**: Language detection, multi-lingual translation, and prompt enhancement via Gemini Flash.

---

## 3. Tier 2: Runtime & Asynchronous Systems

### 2.1. Queue & Worker Pool (`src/queue/`, `src/workers/`)
* **Technology**: BullMQ backed by Redis.
* **Queue**: `v2-workflow-jobs`.
* **Workers**:
  - `useCaseWorker.js`: Pulls jobs, executes `UseCaseRunner`, runs orchestration loops.
  - `walletWorker.js`: Maintenance tasks and failed financial operation retries.
* **Context Preservation**: Every job payload carries `_context`. `wrapWorkerJob` restores the exact `requestId` and `userId` across the async boundary.

### 2.2. Error System & Auto-Recovery (`src/runtime/ErrorSystem.js`, `src/v2/runtime/errorPolicy.js`)
* **Classification Matrix**:
  - `UPSTREAM_FAULT`: External provider down/timeout ➔ Auto `RELEASE` hold, retryable.
  - `USER_FAULT`: Invalid parameters or safety violation ➔ Auto `RELEASE` hold, non-retryable.
  - `BILLING_FAULT`: Insufficient credits ➔ Immediate 402, non-retryable.
  - `SERVER_FAULT`: Internal code error ➔ Auto `ROLLBACK`, non-retryable.

---

## 4. Tier 3: Cross-Cutting Infrastructure

### 4.1. Production Logging & Tracing (`src/infrastructure/logging/`)
* **Engine**: Pino with `pino-pretty` (dev) and NDJSON (prod).
* **Correlation Pipeline**:
  `HTTP (requestLogger)` ➔ `Auth (userId)` ➔ `JobQueue (_context)` ➔ `Worker (wrapWorkerJob)` ➔ `NodeExecutor` ➔ `ProviderClient`.
* **Module Identities**:
  `[HTTP]`, `[AUTH]`, `[CONTROLLER]`, `[USECASE]`, `[BILLING]`, `[WALLET]`, `[QUEUE]`, `[WORKER]`, `[WORKFLOW]`, `[NODE]`, `[MODELS]`, `[PROVIDER]`, `[STORAGE]`, `[DATABASE]`, `[SYSTEM]`.

### 4.2. Persistence & Repositories (`src/db/`)
* Repository pattern cleanly abstracting Supabase Postgres.
* Repositories: `ProjectRepository`, `SessionRepository`, `BatchRepository`, `WorkflowRepository`, `MediaRepository`, `GenerationConfigRepository`, `CharacterRepository`, `DnaRepository`, `ElementRepository`.

### 4.3. Security & Multi-Tenancy (`src/platform/security/`, `src/middleware/auth.js`)
* JWT token authentication via Supabase Auth.
* `TenantAccessService`: Enforces project and asset ownership (cross-tenant data protection).
* `AuthorizationService`: Role-based access control (RBAC).
* `AuditService`: Audit trail for security-critical actions.
