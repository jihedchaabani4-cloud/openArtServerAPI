# apiOpenArt (Labveil) — Business Systems Architecture Specification

> **Purpose:** Complete architectural context for AI coding agents and engineers working on the `apiOpenArt` backend.  
> **Architecture Style:** Strict Modular Monolith (Black-Box Business Systems, Inspired by [Shopify's Componentization & Packwerk](https://shopify.engineering/enforcing-modularity-rails-apps-packwerk)).  
> **Compute Model:** Single Node.js/Express API + BullMQ Async Workers (`v2-workflow-jobs`) orchestrating External AI Providers (WaveSpeed, Google GenAI, LLMService). No self-hosted GPU clusters.

---

## 1. High-Level Topology

The backend is organized around **1 Main Router** (`src/app.js` / `src/routes.js`), **8 Self-Contained Business Systems** (`src/systems/<system>/`), and **1 Shared Infrastructure Layer** (`src/shared/`).

Every Business System is an isolated black box containing everything it needs in one folder:
1. **`public/api.js` (Web Gateway — Optional):** Express route handlers (`req, res`) mounted directly by the Main Router. Omit this file if the system has no HTTP endpoints.
2. **`public/tools.js` (Tools Interface — Optional):** Pure JavaScript/TypeScript functions exposed to other Business Systems and background workers. Omit this file if no other system calls this system.
3. **`internal/` (Strictly Private):** Internal domain services, business logic, validators, repositories, DB queries, and system-specific error classes. **No external file may ever import from `internal/`.**

---

## 2. The 8 Business Systems

| # | System Name | Folder | Public Gateways | Primary Responsibility |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Generation & Workflows** | `src/systems/generation/` | `api.js` only | Orchestrates all AI generation, UseCases, BullMQ queue/workers, V2 DAG runner, and prompt intelligence. |
| 2 | **Models Management** | `src/systems/models/` | `api.js` + `tools.js` | Standalone registry of AI models, capabilities, input schemas, pricing rules, and external provider adapters. |
| 3 | **Billing & Wallet** | `src/systems/billing/` | `api.js` + `tools.js` | User credit balances, credit packages, two-phase holds (reserve/capture/release), stale hold reaper, and failed-ops retry. |
| 4 | **Media & Storage** | `src/systems/media/` | `api.js` + `tools.js` | Save types & validation rules, upload inspection (`sharp`), cloud storage (R2/S3/Supabase), placeholders, and media linking. |
| 5 | **Identity & Auth** | `src/systems/identity/` | `api.js` + `tools.js` | Google OAuth, session cookies, user profiles, and ownership verification (`assertOwns`). |
| 6 | **Characters** | `src/systems/characters/` | `api.js` + `tools.js` | Character CRUD, traits, and reference media linking (no direct AI generation or media DB access). |
| 7 | **Elements** | `src/systems/elements/` | `api.js` + `tools.js` | Visual elements (outfits, props, styles) CRUD, guidelines, and trait extraction. |
| 8 | **Workspace** | `src/systems/workspace/` | `api.js` + `tools.js` | Projects, hierarchical folder trees, and soft-delete trash/restore lifecycle. |

---

## 3. Detailed Anatomy of Each Business System

### System 1: Generation & Workflows (`src/systems/generation/`)
- **Gateways:** `public/api.js` (no `tools.js` needed unless internal automation triggers a workflow).
- **HTTP Endpoints (`public/api.js`):**
  - `POST /api/generate/*` and `POST /api/use-cases/:id/run` (Unified generation entry points)
  - `GET /api/workflows/:runId/status` and `GET /api/workflows/:runId/stream` (SSE / Polling status)
- **Internal Services (`internal/`):**
  - `UseCaseRegistry` & `UseCaseService`: Declarative recipes (`image-generation-v1`, `character-sheet-v1`, `video-generation-v1`, future features).
  - `JobQueueService` & `UseCaseWorker`: BullMQ queue (`v2-workflow-jobs`) and background worker pool.
  - `WorkflowRunner` & `NodeExecutor`: Composable DAG workflow execution engine (note: break the existing cycle by passing an executor callback or separating DAG traversal from node execution).
  - `PromptIntelligenceService`: Prompt translation, enhancement, negative prompt generation, and skills (`applyCameraStyle`, `applyCharacterTemplate`, `enhancePrompt`, `moderationSafety`, etc.).
  - `RunRepository`: Workflow run state persistence.
- **Calls Out To:** `identityTools`, `charactersTools`, `elementsTools`, `modelsTools`, `billingTools`, `mediaTools`.

### System 2: Models Management (`src/systems/models/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):**
  - `GET /api/models` (Catalog presentation, capabilities, public pricing tiers)
  - `POST /api/admin/models/reload` & pricing rule updates
- **Tools Interface (`public/tools.js`):**
  - `getModelConfig(modelId)`
  - `validateModelInputs(modelId, params)`
  - `calculateOperationCost({ modelId, operation, params })`
  - `executeGeneration({ modelId, prompt, params, references })`
  - `executeLLM({ model, prompt, schema, jsonMode })`
- **Internal Services (`internal/`):**
  - `ModelRegistry` & `ModelSchemaValidator`
  - `ModelPricingService` (pure cost calculation; separated from Billing's wallet ledger)
  - `WaveSpeedImageResolver` & `ProviderRunnerRegistry` (WaveSpeed, Google GenAI, LLMService)
  - `CredentialResolver`: Secure API key resolution and provider error mapping (`ProviderTransientError`, `ProviderContentPolicyError`).
- **Extensibility Pattern:** To add a new AI model or provider (e.g., Kling, Veo, ElevenLabs), register its schema, pricing rule, and adapter inside `src/systems/models/internal/` without modifying any other system.

### System 3: Billing & Wallet (`src/systems/billing/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):**
  - `GET /api/wallet/balance`, `GET /api/wallet/transactions`, `GET /api/wallet/packages`
  - `POST /api/admin/wallet/credit`, `GET /api/admin/wallet/reconciliation`
- **Tools Interface (`public/tools.js`):**
  - `getBalance(userId)`
  - `reserveCredits({ userId, amount, idempotencyKey, referenceId })` -> returns `{ holdId }`
  - `captureHold({ holdId, actualAmount })`
  - `releaseHold({ holdId, reason })`
- **Internal Services (`internal/`):**
  - `WalletService` & `TwoPhaseReservationService`
  - `ReservationReaperService` (`handleExpireStaleHolds()` — scheduled job to release orphaned holds)
  - `FailedOpsRetryService` (exponential backoff replay for failed captures/releases)
  - `WalletRepository` & `CreditPackageRepository` (exclusive owners of wallet/ledger/hold tables).

### System 4: Media & Storage (`src/systems/media/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):**
  - `POST /api/media/upload` (Direct user uploads with rate-limiting & MIME inspection)
  - `GET /api/media/:id` & `DELETE /api/media/:id`
- **Tools Interface (`public/tools.js`):**
  - `createPendingMedia({ userId, workflowId, saveType, role })` -> returns `{ mediaId }`
  - `persistExternalMedia({ mediaId, sourceUrl, metadata })` (downloads from provider temp URL, uploads to R2/S3/Supabase, marks ready)
  - `markMediaFailed({ mediaId, errorCode })`
  - `linkMediaToEntity({ mediaId, entityType, entityId, role })`
  - `getMediaUrls(mediaIds)`
- **Internal Services (`internal/`):**
  - `SaveTypeRegistry`: Configurable registry of save types (e.g., `temporary`, `permanent`, `character_sheet`, `character_detail`, `element_reference`, `video_output`, `audio_output`) defining allowed MIME types, max size, and retention policy.
  - `MediaInspector`: Image/video metadata & `sharp` validation.
  - `StorageProvider`: Cloud bucket adapter (`SupabaseStorageProvider` / R2 / S3).
  - `WorkflowMediaRepository` & `MediaRepository`: **Exclusive owners** of media and workflow-media linking tables.

### System 5: Identity & Auth (`src/systems/identity/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):** `/api/auth/google`, `/api/auth/me`, `/api/auth/logout`.
- **Tools Interface (`public/tools.js`):**
  - `verifySession(token)` -> `{ userId, role }`
  - `assertOwns({ userId, resourceOwnerId })`
- **Internal Services (`internal/`):** `AuthService`, `ProfileRepository`, `CookieManager`.

### System 6: Characters (`src/systems/characters/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):** `GET/POST/PATCH/DELETE /api/characters`, `POST /api/characters/:id/media`.
- **Tools Interface (`public/tools.js`):**
  - `getCharacterPromptContext({ userId, characterId })` -> returns `{ name, description, traits, referenceMediaUrls }`
  - `validateCharacterExists({ userId, characterId })`
- **Internal Services (`internal/`):** `CharacterService`, `CharacterMediaFacade` (calls `mediaTools`), `CharacterRepository`.
- **Migration Note:** Remove `CharacterGenerationService` from this system; character sheet generation requests must route to System 1 (`generation`).

### System 7: Elements (`src/systems/elements/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):** `GET/POST/PATCH/DELETE /api/elements`.
- **Tools Interface (`public/tools.js`):**
  - `getElementPromptContext({ userId, elementIds })` -> returns formatted element traits & reference URLs
- **Internal Services (`internal/`):** `ElementService`, `ElementRepository`, `TraitExtractor`.
- **Migration Note:** Remove direct imports of `PromptBuilderProService` and `WorkflowMediaRepository`.

### System 8: Workspace (`src/systems/workspace/`)
- **Gateways:** `public/api.js` + `public/tools.js`.
- **HTTP Endpoints (`public/api.js`):** `/api/projects/*`, `/api/folders/*`, `/api/trash/*`.
- **Tools Interface (`public/tools.js`):**
  - `assertProjectAccess({ userId, projectId })`
  - `moveItemToTrash({ userId, itemType, itemId })`
- **Internal Services (`internal/`):** `ProjectService`, `FolderTreeService`, `TrashService`, `ProjectRepository`, `FolderRepository`, `TrashRepository`.

---

## 4. Mapping Current Graph Report Findings to the Target Structure

| Current Issue in Graph Report | Root Cause | Target Fix |
| :--- | :--- | :--- |
| `WorkflowMediaRepository` has 52 edges (God Node) | `Character`, `Element`, `Trash`, and `V2 Runner` import DB repo directly | Lock `WorkflowMediaRepository` inside `src/systems/media/internal/`; all callers must use `mediaTools` |
| `supabase` has 56 edges | Controllers and services import Supabase client directly | Restrict `supabase` / `supabaseAdmin` imports strictly to `internal/db/` repositories |
| Cycle: `nodeExecutor.js` <-> `workflowRunner.js` | Mutual imports in V2 runner | Inject node execution callback or extract shared types into `internal/contracts.js` |
| Cycle: `ElementService.js` <-> `promptBuilderProService.js` | `ElementService` calls prompt builder and vice versa | Move prompt builder into `generation/internal/`; `generation` calls `elementsTools.getElementPromptContext()` |
| Cycle: `catalogPresentation.js` <-> `models/index.js` | Internal file imports from package barrel `index.js` | Import directly from sibling internal file (`./schema.js`), never from `../index.js` |
| Low cohesion (`0.05–0.08`) in `Character` & `Wallet` | Business logic, model pricing, and media DB calls mixed together | Separate `models` (pricing/schemas) from `billing` (ledger/holds), and `characters` from `generation` |
