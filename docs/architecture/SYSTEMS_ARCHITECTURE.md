# apiOpenArt — Business Systems & Internal Services Reference (`SYSTEMS_ARCHITECTURE.md`)

> **Canonical Location:** `docs/architecture/SYSTEMS_ARCHITECTURE.md`  
> **Architecture:** 8 Self-Contained Business Systems + 1 Shared Technical Kernel (`#shared`) + 1 Main API Router (`src/api/`).

---

## 1. How a Business System Is Structured

Every Business System inside `src/systems/<system>/` is a strict black box. It owns its HTTP controllers, domain services, database repositories, and errors inside one folder.

### Standard Internal Layers Inside Every System
1. **`public/api.js` (Web Gateway):**
   - Exports the Express `Router` mounted by `src/api/routes.js`.
   - Wires route paths and middlewares (`requireAuth`, rate limiters, upload guards) to handlers in `internal/controllers/`.
2. **`public/tools.js` (System Tools Interface):**
   - Exports pure async functions that accept and return plain JSON-serializable DTOs.
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

## 2. Detailed Specification of the 8 Business Systems

### System 1: Generation & Workflows (`src/systems/generation/`)
- **Import Aliases:** `#generation/api`, `#generation/tools`
- **Role:** Central execution brain for all AI generation (images, videos, character sheets, element analysis) powered 100% by the ComfyUI-Style V3 Node Engine (`src/systems/generation/internal/v3/`).
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/images/*`, `/api/video/*`, `/api/prompt/*`, `/api/workflows/*`, and `/api/v2/workflows/*`.
  - `public/tools.js`: Exposes `jobQueueService`, `GenerationService`, `GenerationRequestService`, `WorkflowService`, `WorkflowRepository`, `GenerationConfigRepository`, `V3Dispatcher`, and `configureGeneration`. Internal V3 engine modules remain private to System 1.
  - `internal/controllers/`: `imageController.js`, `videoController.js`, `workflowsController.js`, `generationsQueryController.js`, `generationsMutationController.js`, `projectController.js`.
  - `internal/services/`:
    - `GenerationService.js` & `GenerationRequestService.js`: Request preparation and parameter normalization.
    - `WorkflowService.js`, `WorkflowMediaService.js`, `WorkflowAuthorizationService.js`, `mediaGuards.js`: Workflow state transitions and media attachment coordination.
    - `jobQueueService.js`: BullMQ producer for `v2-workflow-jobs`.
    - `NodeSafetyService.js`: Centralized input validation and safety guardrails.
  - `internal/v3/`:
    - ComfyUI-Style Node Engine Core (`NodeRegistry.js`, `GraphCompiler.js`, `WorkflowExecutor.js`, `V3Dispatcher.js`), 5 Base Nodes (`resolveRefsNode.js` [`base.resolve_references`], `llmNode.js` [`base.llm`], `imageGenerateNode.js` [`base.image_generate`], `videoGenerateNode.js` [`base.video_generate`], `saveMediaNode.js` [`base.save_media`]), 0 Custom Nodes, and 3 Declarative V3 Workflows (`imageGenerationV3.js`, `videoGenerationV3.js`, `characterSheetV3.js`).
  - `internal/resolvers/`: `WorkflowReferenceResolver.js` for resolving referenced workflows, characters, and elements.
  - `internal/gateways/`: `workflowBillingGateway.js` (calls `#billing/tools`).
  - `internal/workers/`: `useCaseWorker.js` and `worker.js` (BullMQ consumers executing V3 runs via `V3Dispatcher` and settling holds/media).
  - `internal/db/`: `generationClient.js`, `BaseRepository.js`, `WorkflowRepository.js`, `GenerationConfigRepository.js`, `RunRepository.js`, `dbMap.js`.
- **Owned Database Tables:** `workflows`, `workflow_runs`, `node_runs`, `generation_configs`.

---

### System 2: Models Management (`src/systems/models/`)
- **Import Aliases:** `#models/api`, `#models/tools`
- **Role:** Standalone registry and execution adapter for all AI models (image, video, LLM), input schemas, conditional parameter rules, model pricing calculation, and external AI providers (WaveSpeed, Google GenAI, LTX).
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/models/*` and admin model reload/pricing endpoints.
  - `public/tools.js`: Exposes `getModelConfig`, `getCatalog`, `calculateCost`, `validateModelInputs`, `executeGeneration`, `executeLLM`, `initRegistry`, `reloadRegistry`, `getRegistryStats`, `PricingService`, `llmService`, `promptService`.
  - `internal/controllers/`: `modelsController.js`.
  - `internal/services/`: `PricingService.js`, `LLMService.js`, `PromptService.js`, `catalogQueries.js`, `catalogPresentation.js`, `credentialResolver.js`.
  - `internal/registry/`: `modelRegistry.js`, `bindingResolver.js`.
  - `internal/execution/` & `internal/mapping/` & `internal/schema/` & `internal/pricing/`: `modelRunner.js`, `runtimeExecutor.js`, `circuitBreaker.js`, `idempotencyStore.js`, `errorNormalizer.js`, `parameterMapper.js`, `outputValidator.js`, `schemaValidator.js`, `conditionalRules.js`, `pricingEngine.js`.
  - `internal/runtime/`: Provider adapters (`wavespeed/`, `google/`, `ltx/`, `generic/`), `providerRuntimeRegistry.js`, `sseStreamReader.js`.
  - `internal/manifests/`: JSON model & provider manifests (`manifests/`).
  - `internal/db/`: `modelsClient.js`.
  - `internal/errors.js`: Unified model, binding, validation, and provider errors (`ModelNotFoundError`, `ProviderTransientError`, `ProviderContentPolicyError`, `OutputContractViolationError`).
- **Owned Database Tables:** `models_catalog`, `model_pricing_rules`, `provider_bindings`.

---

### System 3: Billing & Wallet (`src/systems/billing/`)
- **Import Aliases:** `#billing/api`, `#billing/tools`
- **Role:** Financial ledger managing user credit balances, credit packages, two-phase credit holds (`reserve`, `capture`, `release`), stale hold expiration reaper, and failed operations retry.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/wallet/*`, `/api/payments/*`, and `/api/admin/*`.
  - `public/tools.js`: Exposes `getCreditBalance`, `addCredits`, `reserveCredits`, `settleCredits`, `rollbackCredits`, `getBillingService`, `FailedOpsService`.
  - `internal/controllers/`: `walletController.js`, `adminController.js`, `payments/`.
  - `internal/services/`: `WalletService.js`, `ReservationReaperService.js`, `FailedOpsService.js`, `serviceAccessor.js`.
  - `internal/workers/`: `walletQueue.js`, `walletWorker.js`.
  - `internal/db/`: `billingClient.js`, `WalletRepository.js`, `TransactionRepository.js`, `CreditPackageRepository.js`, `FailedOpsRepository.js`, `UsageEventRepository.js`.
  - `internal/errors.js`: `BillingError`, `BillingInsufficientFundsError`, `BillingConflictError`, `BillingNotFoundError`, `BillingValidationError`.
- **Owned Database Tables:** `wallets`, `credit_transactions`, `credit_reservations`, `credit_packages`, `failed_billing_ops`, `usage_events`.

---

### System 4: Media & Storage (`src/systems/media/`)
- **Import Aliases:** `#media/api`, `#media/tools`
- **Role:** Exclusive owner of all media assets, declarative save types & quota policies, upload MIME/resolution inspection (`sharp`), cloud storage buckets (Supabase Storage / S3 / R2), and workflow-media linking.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/media/*` and `/api/assets/*`.
  - `public/tools.js`: Exposes `MediaService`, `AssetUploadService`, `createMediaInWorkflow`, `markMediaStatus`, `markMediaFailed`, `failWorkflowPendingMedia`, `linkWorkflowMediaForCreatedRow`, `createUploadMiddleware`, `saveTypeRegistry`.
  - `internal/controllers/`: `mediaController.js`.
  - `internal/services/`: `MediaService.js`, `MediaLifecycleService.js`, `AssetUploadService.js`, `MediaUploadService.js`, `mediaMetadataResolver.js`, `v1StorageBridge.js`, `saveTypes.js`, `serviceAccessor.js`.
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
  - `public/api.js`: Mounts `/api/auth/*`.
  - `public/tools.js`: Exposes `verifySession`, `getUserProfile`, `assertOwns`, `assertOwnsAny`, `toMediaIdList`, `requireAuth`, `requireAdmin`, `rateLimit`, `walletRateLimit`, `safeCompareSecret`.
  - `internal/controllers/`: `authController.js`.
  - `internal/services/`: `AuthService.js`, `OAuthService.js`, `OwnershipService.js`, `cookies.js`, `secretComparison.js`.
  - `internal/middleware/`: `auth.js`, `requireAdmin.js`, `rateLimit.js`, `walletRateLimit.js`.
  - `internal/db/`: `authClient.js`, `ProfileRepository.js`, `ownershipDb.js`.
  - `internal/errors.js`: `IdentityError`, `IdentityAuthenticationError`, `IdentityForbiddenError`, `IdentityNotFoundError`, `IdentityValidationError`.
- **Owned Database Tables:** `profiles` (and Supabase `auth.users`).

---

### System 6: Characters (`src/systems/characters/`)
- **Import Aliases:** `#characters/api`, `#characters/tools`
- **Role:** Manages persistent AI character personas, traits, and multi-view reference media links. Delegates sheet/description generation to `#generation/tools` and media storage to `#media/tools`.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/characters/*`.
  - `public/tools.js`: Exposes `CharacterService`, `CharacterMediaService`, `CharacterGenerationService`, `getCharacterPromptContext`.
  - `internal/controllers/`: `characterController.js`.
  - `internal/services/`: `CharacterService.js`, `CharacterMediaService.js`, `CharacterGenerationService.js`, `serviceAccessor.js`.
  - `internal/db/`: `characterClient.js`, `CharacterRepository.js`.
  - `internal/errors.js`: Unified character domain errors.
- **Owned Database Tables:** `characters`, `character_media`.

---

### System 7: Elements (`src/systems/elements/`)
- **Import Aliases:** `#elements/api`, `#elements/tools`
- **Role:** Manages reusable visual elements (outfits, props, styles, backgrounds), consistency guidelines, and `@Element` prompt token resolution.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/elements/*`.
  - `public/tools.js`: Exposes `ElementService`, `ElementMediaService`, `ElementAnalysisService`, `PromptBuilderProService`, `extractElementTokens`, `stripElementTokens`, `getElementContextForPrompt`.
  - `internal/controllers/`: `elementController.js`.
  - `internal/services/`: `ElementService.js`, `ElementMediaService.js`, `ElementAnalysisService.js`, `promptBuilderProService.js`, `serviceAccessor.js`.
  - `internal/middleware/`: `elementUploadGuard.js`.
  - `internal/db/`: `elementClient.js`, `ElementRepository.js`.
  - `internal/errors.js`: Unified element domain errors.
- **Owned Database Tables:** `elements`, `element_media`.

---

### System 8: Workspace (`src/systems/workspace/`)
- **Import Aliases:** `#workspace/api`, `#workspace/tools`
- **Role:** Organizes user projects, cycle-safe hierarchical folder trees, and two-stage soft-delete trash/restore lifecycle.
- **Directory Structure & Internal Services:**
  - `public/api.js`: Mounts `/api/projects/*`, `/api/folders/*`, and `/api/trash/*`.
  - `public/tools.js`: Exposes `ProjectService`, `ProjectReadService`, `FolderService`, `folderTree`, `TrashService`.
  - `internal/controllers/`: `projectsController.js`, `foldersController.js`, `trashController.js`.
  - `internal/services/`: `ProjectService.js`, `ProjectReadService.js`, `FolderService.js`, `folderTree.js`, `TrashService.js`, `serviceAccessor.js`.
  - `internal/db/`: `workspaceClient.js`, `ProjectRepository.js`, `FolderRepository.js`, `TrashRepository.js`.
  - `internal/errors.js`: `FolderError`, `WorkspaceError`, `TrashError`.
- **Owned Database Tables:** `projects`, `folders`, `trash_items`.
