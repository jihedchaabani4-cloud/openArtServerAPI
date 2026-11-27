# apiOpenArt — Business Systems & Internal Services Reference (`SYSTEMS_ARCHITECTURE.md`)

> **Canonical Location:** `docs/architecture/SYSTEMS_ARCHITECTURE.md`  
> **Architecture:** 9 Self-Contained Business Systems + 1 Segmented Shared Technical Kernel (`#shared` & `#shared/redis`) + 1 Main API Router (`src/api/`).

---

## 1. How a Business System Is Structured

Every Business System inside `src/systems/<system>/` is a strict black box. It owns its HTTP controllers (if HTTP-facing), domain services, database repositories (if DB-backed), and errors inside one folder.

### Standard Internal Layers Inside Every System
1. **`public/api.js` (Web Gateway — HTTP-facing systems only):**
   - Exports the Express `Router` mounted by `src/api/routes.js`.
   - Wires route paths and middlewares (`requireAuth`, rate limiters, upload guards) to handlers in `internal/controllers/`.
2. **`public/tools.js` (System Tools Interface):**
   - Exports pure async functions / DTO factories that accept and return plain JSON-serializable DTOs.
   - This is the **only** file other Business Systems may import (via `#<system>/tools`).
3. **`internal/controllers/`:**
   - Extracts HTTP inputs (`req.body`, `req.params`, `req.query`, `req.user.id`), invokes `internal/services/`, and formats the HTTP response (`res.status(...).json(...)`).
   - Contains **zero** SQL/Supabase queries and **zero** duplicated domain rules.
4. **`internal/services/`:**
   - Contains the core business logic, domain orchestration, and `serviceAccessor.js` (for dependency injection in tests and runtime).
   - Calls `internal/db/` repositories for own data, and `#<other_system>/tools` for external system actions.
5. **`internal/db/`:**
   - Contains `<system>Client.js` (isolated database client wrapper) and the system's Repository classes.
   - **Exclusive Table Ownership:** Only repositories in this folder may read or write the database tables owned by this system.
6. **`internal/errors.js`:**
   - Single consolidated file defining all domain errors for the system (extending `AppError` from `#shared`).

---

## 2. Detailed Specification of the 9 Business Systems

### System 1: Generation & Workflows (`src/systems/generation/`)
- **Import Aliases:** `#generation/api`, `#generation/tools`
- **Role:** Generation API, 1x fail-fast domain intake guards, BullMQ queue dispatching (`workflow-jobs`), and background worker execution delegating DAG runs to System 9 (`#workflow-engine/tools`) as a pure black box.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Sealed gateway exporting ONLY the 4 mounted routers: `imagesRouter` (`/api/images/*`), `videoRouter` (`/api/video/*`), `workflowsRouter` (`/api/workflows/*`), and `v2WorkflowsRouter` (`/api/v2/workflows/*`).
  - `public/tools.js`: Sealed 7-export surface exposing `configureGeneration`, `startGenerationWorker`, `WorkflowDispatchService`, `GenerationService`, `GenerationRequestService`, `WorkflowService`, and `WorkflowRepository`.
  - `internal/controllers/`: `imageController.js`, `videoController.js`, `generationControllerHelpers.js`, `workflowsController.js`, `generationsQueryController.js`, `generationsMutationController.js`, `projectController.js`.
  - `internal/services/`:
    - `GenerationService.js` & `GenerationRequestService.js`: 1x fail-fast intake gate, ownership checks, edit locks, placeholder persistence, and dispatch compensation.
    - `imageEditContract.js`: In-place image edit validation, raw-URL ban, inline entity extraction, and single-source relight/angles prompt templates.
    - `WorkflowDispatchService.js`: Consolidated BullMQ queue producer (`workflow-jobs`) with upfront `#workflow-engine/tools` `verifyInput()` validation and 3-attempt enqueue backoff.
    - `WorkflowService.js`, `WorkflowMediaService.js`, `WorkflowAuthorizationService.js`, `mediaGuards.js`, `serviceAccessor.js`: Workflow state transitions, media-type guards, and DI wiring.
  - `internal/workers/`: `useCaseWorker.js` (BullMQ consumer spawning one fresh `createWorkflowEngine({ adapters, onFailure })` per job + `createGenerationFailureHandler`) and `worker.js` (starts `useCaseWorker` + 5m Reservation Reaper).
  - `internal/db/`: `generationClient.js`, `BaseRepository.js`, `WorkflowRepository.js`.
- **Owned Database Tables:** `workflows`, `workflow_runs`, `node_runs`, `generation_configs`.

---

### System 2: Models Management (`src/systems/models/`)
- **Import Aliases:** `#models/api`, `#models/tools`
- **Role:** Standalone, pure black-box registry and execution adapter for all AI models (image, video, LLM), input schemas, conditional parameter rules, model pricing calculation, and external AI providers (WaveSpeed, Google GenAI, LTX, Runway). Zero database or Redis dependencies.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts public read-only `/api/models/*` catalog, schema, and price estimation endpoints.
  - `public/tools.js`: Exposes `getModelConfig`, `getCatalog`, `getModelSchema`, `calculateCost`, `validateModelInputs`, `executeGeneration`, `executeLLM`, `reloadRegistry`, and the 5 canonical `Models*Error` classes.
  - `internal/controllers/`: `modelsController.js`.
  - `internal/services/`: `LLMService.js`, `catalogQueries.js`, `catalogPresentation.js`, `credentialResolver.js`.
  - `internal/registry/`: `modelRegistry.js`, `bindingResolver.js`.
  - `internal/execution/` & `internal/mapping/` & `internal/schema/` & `internal/pricing/`: `modelRunner.js`, `runtimeExecutor.js`, `circuitBreaker.js`, `idempotencyStore.js`, `errorNormalizer.js`, `parameterMapper.js`, `outputValidator.js`, `schemaValidator.js`, `conditionalRules.js`, `pricingEngine.js`.
  - `internal/runtime/`: Provider adapters (`wavespeed/`, `google/`, `ltx/`, `runway/`, `generic/`), `providerRuntimeRegistry.js`, `sseStreamReader.js`.
  - `internal/manifests/`: JSON model & provider manifests (`manifests/`).
  - `internal/errors.js`: Unified model, binding, validation, and provider errors (`ModelsError`, `ModelsValidationError`, `ModelsNotFoundError`, `ModelsConfigurationError`, `ModelsProviderError`).
- **Owned Database Tables:** None (config-driven via JSON manifests).

---

### System 3: Billing & Wallet (`src/systems/billing/`)
- **Import Aliases:** `#billing/api`, `#billing/tools`
- **Role:** Financial ledger managing user credit balances, credit packages, two-phase credit holds (`reserve`, `capture`, `release`), stale hold expiration reaper, and failed operations retry.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/wallet/*` (`walletRouter`) and `/api/payments/*` (`paymentsRouter`).
  - `public/tools.js`: Sealed surface exposing `getCreditBalance`, `reserveCredits`, `settleCredits`, `rollbackCredits`, `extendHold`, `addCredits`, `listTransactions`, `listCreditPackages`, `configureBilling`, `createWalletService`, `createFailedOpsService`, `runReservationReaper`, `startWalletWorker`, `stopWalletWorker`, and canonical `Billing*Error` / `WalletError` classes.
  - `internal/controllers/`: `walletController.js`, `paymentsController.js`, `payments/`.
  - `internal/services/`: `WalletService.js`, `ReservationReaperService.js`, `FailedOpsService.js`, `serviceAccessor.js`.
  - `internal/workers/`: `walletQueue.js`, `walletWorker.js`.
  - `internal/db/`: `billingClient.js`, `billingRepositoryFactory.js`, `WalletRepository.js`, `TransactionRepository.js`, `CreditPackageRepository.js`, `FailedOpsRepository.js`, `UsageEventRepository.js`.
  - `internal/errors.js`: `BillingError`, `BillingValidationError`, `BillingNotFoundError`, `BillingInsufficientFundsError`, `BillingConflictError`, `BillingConfigurationError`, `WalletError`.
- **Owned Database Tables:** `wallets`, `credit_transactions`, `credit_reservations`, `credit_packages`, `failed_billing_ops`, `usage_events`.

---

### System 4: Media & Storage (`src/systems/media/`)
- **Import Aliases:** `#media/api`, `#media/tools`
- **Role:** Exclusive owner of all media assets, declarative save types & quota policies, upload MIME/resolution inspection (`sharp`), cloud storage buckets (Supabase Storage / S3 / R2), and workflow-media linking.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Sealed gateway mounting `/api/media/*` (`mediaIngestRouter`), `/api/assets/*` (`assetsRouter`), and `createUploadMiddleware`.
  - `public/tools.js`: Sealed surface exposing DTO media tools (`createPendingMedia`, `persistExternalMedia`, `completeMedia`, `markMediaFailed`, `linkMediaToEntity`, `getMediaUrls`, `getMediaById`, `getWorkflowVisualMedia`, `getWorkflowPrimaryMedia`, `deleteMedia`), composition/lifecycle services, upload policies, and typed `Media*Error` classes.
  - `internal/controllers/`: `mediaController.js`.
  - `internal/services/`: `MediaService.js`, `MediaLifecycleService.js`, `AssetUploadService.js`, `MediaUploadService.js`, `mediaMetadataResolver.js`, `saveTypes.js`, `serviceAccessor.js`.
  - `internal/ingestion/`: `MediaInspector.js` (`sharp`), `MediaMetadataExtractor.js`, `SourcePolicy.js` (SSRF protection), `SourceReader.js`, `SourceResolver.js`, `UploadPolicy.js`, `sizeLimitedStorage.js`.
  - `internal/storage/`: `StorageService.js`, `StoragePathResolver.js`, `storageFactory.js`, `IStorageProvider.js`, `streamUtils.js`, `providers/SupabaseStorageProvider.js`, `providers/InMemoryStorageProvider.js`.
  - `internal/db/`: `mediaClient.js`, `MediaRepository.js`, `WorkflowMediaRepository.js`, `workflowMediaLinker.js`, `workflowMediaOps.js`, `workflowMediaRole.js`.
  - `internal/errors.js`: Unified `MediaError`, `UploadError`, `QuotaError`, `StorageError`, `StorageValidationError`.
- **Owned Database Tables:** `media`, `workflow_media`.

---

### System 5: Identity & Security (`src/systems/identity/`)
- **Import Aliases:** `#identity/api`, `#identity/tools`
- **Role:** Authentication (Email, Google OAuth, Microsoft OAuth), HTTP-only session cookies, user profiles, rate limiting, and fail-closed resource ownership verification (`assertOwns`).
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/auth/*` via `authRouter`.
  - `public/tools.js`: Sealed surface exposing `requireAuth`, `rateLimit`, `walletRateLimit`, `assertOwns`, `assertOwnsAny`, `toMediaIdList`, `getAuthUserById`, `configureIdentityHooks`, `configureOwnershipResolvers`, and canonical `Identity*Error` classes.
  - `internal/controllers/`: `authController.js`.
  - `internal/services/`: `AuthService.js`, `OAuthService.js`, `OwnershipService.js`, `cookies.js`, `jwtVerifier.js`, `secretComparison.js`.
  - `internal/middleware/`: `auth.js`, `rateLimit.js`, `walletRateLimit.js`.
  - `internal/db/`: `authClient.js`, `ProfileRepository.js`.
  - `internal/errors.js`: `IdentityError`, `IdentityAuthenticationError`, `IdentityForbiddenError`, `IdentityNotFoundError`, `IdentityValidationError`.
- **Owned Database Tables:** `profiles` (and Supabase `auth.users`).

---

### System 6: Characters (`src/systems/characters/`)
- **Import Aliases:** `#characters/api`, `#characters/tools`
- **Role:** Manages persistent AI character personas, traits, and multi-view reference media links. Dispatches character sheet generation via `WorkflowDispatchService` (`#generation/tools`) and delegates media storage to `#media/tools`.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Sealed gateway exporting ONLY `charactersRouter` (`/api/characters/*`).
  - `public/tools.js`: Sealed surface exposing `CharacterService`, `CharacterMediaService`, `CharacterRepository`, `configureCharacters`, `getCharacterPromptContext`, `validateCharacterExists`, and canonical `Characters*Error` classes (`CharactersError`, `CharactersValidationError`, `CharactersNotFoundError`, `CharactersConflictError`, `CharactersUnauthorizedError`).
  - `internal/controllers/`: `characterController.js`.
  - `internal/services/`: `CharacterService.js`, `CharacterMediaService.js`, `CharacterGenerationService.js`, `serviceAccessor.js`.
  - `internal/db/`: `characterClient.js`, `CharacterRepository.js`.
  - `internal/errors.js`: `CharactersError`, `CharactersValidationError`, `CharactersNotFoundError`, `CharactersConflictError`, `CharactersUnauthorizedError`.
- **Owned Database Tables:** `characters`, `character_media`.

---

### System 7: Elements (`src/systems/elements/`)
- **Import Aliases:** `#elements/api`, `#elements/tools`
- **Role:** Manages reusable visual elements (outfits, props, styles, backgrounds), consistency guidelines, and `@Element` prompt token resolution.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Sealed gateway exporting ONLY `elementRoutes` (`/api/v2/elements/*`).
  - `public/tools.js`: Sealed surface exposing `ElementService`, `ElementMediaService`, `ElementAnalysisService`, `ElementRepository`, `configureElements`, `getElementPromptContext`, `validateElementsExist`, and canonical `Elements*Error` classes (`ElementsError`, `ElementsValidationError`, `ElementsNotFoundError`, `ElementsConflictError`, `ElementsUnauthorizedError`).
  - `internal/controllers/`: `elementController.js`.
  - `internal/services/`: `ElementService.js`, `ElementMediaService.js`, `ElementAnalysisService.js`, `promptBuilderProService.js`, `serviceAccessor.js`.
  - `internal/middleware/`: `elementUploadGuard.js`.
  - `internal/db/`: `elementClient.js`, `ElementRepository.js`.
  - `internal/errors.js`: `ElementsError`, `ElementsValidationError`, `ElementsNotFoundError`, `ElementsConflictError`, `ElementsUnauthorizedError`.
- **Owned Database Tables:** `elements`, `element_media`.

---

### System 8: Workspace (`src/systems/workspace/`)
- **Import Aliases:** `#workspace/api`, `#workspace/tools`
- **Role:** Organizes user projects, cycle-safe hierarchical folder trees, and two-stage soft-delete trash/restore lifecycle.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Sealed gateway exporting ONLY the 4 mounted routers: `projectsRouter` (`/api/projects/*`), `foldersRouter` (`/api/folders/*`), `trashRouter` (`/api/trash/*`), and `workspaceBulkRouter` (`/api/workspace/*`).
  - `public/tools.js`: Sealed surface exposing `ProjectService`, `ProjectReadService`, `FolderService`, `TrashService`, `ProjectRepository`, `FolderRepository`, `TrashRepository`, `trashRepository`, `configureWorkspace`, `assertProjectAccess`, `moveItemToTrash`, `FolderError`, and canonical `Workspace*Error` classes (`WorkspaceError`, `WorkspaceValidationError`, `WorkspaceNotFoundError`, `WorkspaceConflictError`, `WorkspaceUnauthorizedError`).
  - `internal/controllers/`: `projectsController.js`, `foldersController.js`, `trashController.js`.
  - `internal/services/`: `ProjectService.js`, `ProjectReadService.js`, `FolderService.js`, `folderTree.js`, `TrashService.js`, `serviceAccessor.js`.
  - `internal/db/`: `workspaceClient.js`, `ProjectRepository.js`, `FolderRepository.js`, `TrashRepository.js`.
  - `internal/errors.js`: `WorkspaceError`, `WorkspaceValidationError`, `WorkspaceNotFoundError`, `WorkspaceConflictError`, `WorkspaceUnauthorizedError`, `FolderError`.
- **Owned Database Tables:** `projects`, `folders`, `trash_items`.

---

### System 9: Workflow Engine (`src/systems/workflow-engine/`)
- **Import Aliases:** `#workflow-engine/tools` *(no `public/api.js` — pure internal library system)*
- **Role:** Standalone, 100% queue-free, Redis-free, DB-free, single-execution DAG runner usable anywhere (inside a BullMQ worker, directly inside an HTTP service, or in a standalone script). Mechanically protected by `Rule R18`.
- **Directory Structure & Internal Modules:**
  - `public/tools.js`: Sealed **11-export** black-box surface: `verifyInput`, `calculateCost`, `createWorkflowEngine`, `runWorkflow`, `configureWorkflowAdapters`, and the 6 neutral `Workflow*Error` classes.
  - `internal/core/`: `NodeRegistry.js`, `GraphCompiler.js` (instance-scoped `WeakMap` plan cache), `JobExecutionContext.js`, `WorkflowExecutor.js` (reuses engine's `GraphCompiler`), `ExecutionEngine.js` (pure single-execution runner with pre-Wave-1 adapter validation and per-instance/per-run `onSuccess`/`onFailure` hooks).
  - `internal/adapters.js`: 9-key adapter seam (`getCharacterPromptContext`, `getElementPromptContext`, `getMediaById`, `getMediaUrls`, `getWorkflowPrimaryMedia`, `completeMedia`, `persistExternalMedia`, `assertOwns`, `assertOwnsAny`) wired once in `src/container.js` and locked in non-test environments.
  - `internal/nodes/`: `index.js` + 7 pure Base Nodes (`resolveRefsNode.js`, `llmNode.js`, `extractNode.js`, `textTemplateNode.js`, `imageGenerateNode.js`, `videoGenerateNode.js`, `saveMediaNode.js`, `mediaNodeHelpers.js`).
  - `internal/skills/`: `index.js` + 7 active `SKILL.md` skills.
  - `internal/workflows/`: `index.js` + 7 declarative V3 workflow blueprints (`imageGenerationV3.js`, `videoGenerationV3.js`, `characterSheetV3.js`, `imageEditV3.js`, `imageRelightV3.js`, `imageAnglesV3.js`, `imageRemoveBackgroundV3.js`).
  - `internal/errors.js`: `WorkflowEngineError`, `WorkflowValidationError`, `WorkflowCompilationError`, `WorkflowUpstreamError`, `WorkflowNotFoundError`, `WorkflowSafetyError`.
- **Owned Database Tables:** None (100% stateless and DB-free).
