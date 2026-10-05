# Work-in-Progress (WIP) Commit Plan & Dependency Analysis

> [!IMPORTANT]
> This document is a read-only proposal. None of the uncommitted files have been staged, committed, or deleted.

---

## 1. Uncommitted & Untracked Files Grouping (Proposed Commits)

The 66 modified files and 36 untracked files are grouped into 6 atomic, logical commits designed to be applied in order so each commit builds and passes tests:

### Commit 1: `feat(platform): add platform media and storage infrastructure layer`
- **Purpose**: Establishes core storage abstractions, MIME inspection, SSRF-safe reader, and aspect ratio utilities required across controllers, models, and workers.
- **Files**:
  - `src/platform/media/MediaService.js` (untracked)
  - `src/platform/media/mediaMetadataResolver.js` (untracked)
  - `src/platform/media-ingestion/` (untracked: `MediaIngestionService.js`, `MediaInspector.js`, `SourcePolicy.js`, `SourceReader.js`, `SourceResolver.js`, `index.js`)
  - `src/platform/storage/IStorageProvider.js` (untracked)
  - `src/platform/storage/StoragePathResolver.js` (untracked)
  - `src/platform/storage/mediaStorageService.js` (modified)
  - `src/platform/storage/storage/providers/SupabaseStorageProvider.js` (modified)
  - `src/utils/ratioUtils.js` (untracked)
  - `src/utils/MediaMetadataExtractor.js` (modified)

### Commit 2: `feat(workflow): add workflow authorization and media lifecycle services`
- **Purpose**: Establishes tenant isolation, multi-tenant authorization helpers, and workflow/project read/generation domain services.
- **Files**:
  - `src/platform/workflow/WorkflowAuthorizationService.js` (untracked)
  - `src/platform/workflow/WorkflowMediaService.js` (untracked)
  - `src/platform/workflow/WorkflowServiceBase.js` (modified)
  - `src/infrastructure/storage/workflowStorageGateway.js` (modified)
  - `src/domain/project/ProjectReadService.js` (modified)
  - `src/domain/generation/GenerationService.js` (modified)
  - `controllers/projectController.js` (modified)
  - `controllers/workflowsController.js` (modified)
  - `lib/mediaGuards.js` (modified)

### Commit 3: `feat(character-element): add character and element media domain services and migrations`
- **Purpose**: Wires character and element media management, element repository improvements, and SQL schema migrations.
- **Files**:
  - `src/domain/character/CharacterMediaService.js` (untracked)
  - `src/domain/character/index.js` (untracked)
  - `src/domain/element/ElementMediaService.js` (untracked)
  - `src/db/ElementRepository.js` (modified)
  - `migrations/20260924_drop_element_keywords_tags.sql` (untracked)
  - `migrations/20260925_convert_element_guidelines_to_text.sql` (untracked)
  - `routes/characters.js` (modified)
  - `routes/elementRoutes.js` (modified)

### Commit 4: `feat(routes): add canonical media ingest and video express routes`
- **Purpose**: Registers `/api/media/ingest` and `/api/video/*` endpoints with full input validation and authentication.
- **Files**:
  - `routes/mediaIngestRoutes.js` (untracked)
  - `routes/video.js` (untracked)
  - `routes/assets.js` (modified)
  - `routes/images.js` (modified)
  - `routes/modelsRoute.js` (modified)
  - `src/api/routes.js` (modified)

### Commit 5: `feat(models-v2): add ltx video models, gemini flash-lite manifests, and video generation v1 workflow`
- **Purpose**: Adds LTX model provider and runtime runner, updated Gemini flash-lite manifests, and V2 video-generation workflow definitions.
- **Files**:
  - `src/models/manifests/gemini_2_0_flash/model.json` (modified)
  - `src/models/manifests/gemini_2_0_flash_lite/model.json` (modified)
  - `src/models/manifests/gemini_3_flash/model.json` (modified)
  - `src/models/manifests/gemini_3_1_flash_lite/` (untracked)
  - `src/models/manifests/gemini_3_5_flash_lite/` (untracked)
  - `src/models/manifests/gemini_flash_lite_latest/` (untracked)
  - `src/models/manifests/gpt_image_2/` (modified)
  - `src/models/manifests/nanobana_2/` (modified)
  - `src/models/manifests/nanobana_pro/` (modified)
  - `src/models/manifests/nanobana_pro_ultra/` (modified)
  - `src/models/manifests/seedance_2_5/` (modified)
  - `src/models/manifests/seedance_2_5_extend/` (modified)
  - `src/models/manifests/seedream_v5/` (modified)
  - `src/models/manifests/wan_3_0/` (modified)
  - `src/models/manifests/wavespeed_upscale/` (modified)
  - `src/models/manifests/ltx_*` (untracked)
  - `src/models/providers/ltx.json` (untracked)
  - `src/models/runtime/ltx/` (untracked)
  - `src/models/runtime/wavespeed/` (modified)
  - `src/models/runtime/generic/restRunner.js` (modified)
  - `src/models/mapping/parameterMapper.js` (modified)
  - `src/models/registry/modelRegistry.js` (modified)
  - `src/models/schema/schemaValidator.js` (modified)
  - `src/models/shared/image-parameters.json` (modified)
  - `src/models/shared/video-parameters.json` (modified)
  - `src/models/execution/errorNormalizer.js` (modified)
  - `src/use-cases/definitions/imageGeneration.js` (modified)
  - `src/use-cases/definitions/videoGeneration.js` (untracked)
  - `src/use-cases/registerUseCases.js` (modified)
  - `src/use-cases/useCaseSchema.js` (modified)
  - `src/v2/nodes/safety/NodeSafetyService.js` (modified)
  - `src/v2/registry/nodes.yaml` (modified)
  - `src/v2/registry/workflows/image-generation-v1.yaml` (modified)
  - `src/v2/registry/workflows/video-generation-v1.yaml` (untracked)

### Commit 6: `fix(infrastructure): sync package-lock, queue workers, base repositories, and boundary tests`
- **Purpose**: Locks dependencies for `npm ci`, aligns BullMQ queue configurations, repository helpers, and adds comprehensive pre-Phase 0 boundary test suites.
- **Files**:
  - `package-lock.json` (modified)
  - `src/db/BaseRepository.js` (modified)
  - `src/db/WorkflowRepository.js` (modified)
  - `src/queue/redis.js` (modified)
  - `src/services/jobQueueService.js` (modified)
  - `src/workers/reservationReaperWorker.js` (modified)
  - `src/workers/useCaseWorker.js` (modified)
  - `src/workers/worker.js` (modified)
  - `scripts/validate-all-configs.js` (modified)
  - `tests/boundary/modelsBoundary.test.js` (modified)
  - `tests/boundary/apiRoutingBoundary.test.js` (untracked)
  - `tests/boundary/rateLimitBoundary.test.js` (untracked)
  - `tests/boundary/reaperReconciliationBoundary.test.js` (untracked)
  - `docs/audit/` (untracked)
  - `docs/release/phase0-rc-verification.md` (untracked)

---

## 2. Dependency List: Tracked Phase 0 Files Importing Untracked Files

The following 18 tracked files in HEAD import modules that currently exist only as untracked files in the working tree. This is the exact root cause of `ERR_MODULE_NOT_FOUND` on a clean git checkout:

| Tracked File (in git HEAD) | Line | Imported Path | Untracked Target File |
| :--- | :---: | :--- | :--- |
| `controllers/imageController.js` | 7 | `../src/platform/media/mediaMetadataResolver.js` | `src/platform/media/mediaMetadataResolver.js` |
| `controllers/videoController.js` | 4 | `../src/platform/media/mediaMetadataResolver.js` | `src/platform/media/mediaMetadataResolver.js` |
| `src/v2/runner/nodeExecutor.js` | 18 | `../../platform/media/mediaMetadataResolver.js` | `src/platform/media/mediaMetadataResolver.js` |
| `src/api/routes.js` | 5 | `../../routes/video.js` | `routes/video.js` |
| `src/api/routes.js` | 18 | `../../routes/mediaIngestRoutes.js` | `routes/mediaIngestRoutes.js` |
| `src/container.js` | 159 | `./platform/media/MediaService.js` | `src/platform/media/MediaService.js` |
| `src/container.js` | 161 | `./platform/media-ingestion/MediaIngestionService.js` | `src/platform/media-ingestion/MediaIngestionService.js` |
| `src/domain/character/CharacterService.js` | 14 | `./CharacterMediaService.js` | `src/domain/character/CharacterMediaService.js` |
| `src/domain/element/ElementService.js` | 19 | `./ElementMediaService.js` | `src/domain/element/ElementMediaService.js` |
| `src/domain/generation/GenerationService.js` | 15 | `../../utils/ratioUtils.js` | `src/utils/ratioUtils.js` |
| `src/domain/project/ProjectReadService.js` | 4 | `../../utils/ratioUtils.js` | `src/utils/ratioUtils.js` |
| `src/utils/MediaMetadataExtractor.js` | 9 | `./ratioUtils.js` | `src/utils/ratioUtils.js` |
| `src/platform/storage/StorageService.js` | 2 | `./StoragePathResolver.js` | `src/platform/storage/StoragePathResolver.js` |
| `src/platform/storage/StorageService.js` | 3 | `../media-ingestion/SourceReader.js` | `src/platform/media-ingestion/SourceReader.js` |
| `src/platform/storage/StorageService.js` | 4 | `../media-ingestion/SourcePolicy.js` | `src/platform/media-ingestion/SourcePolicy.js` |
| `src/platform/storage/StorageService.js` | 5 | `../media-ingestion/MediaInspector.js` | `src/platform/media-ingestion/MediaInspector.js` |
| `src/platform/storage/storage/providers/SupabaseStorageProvider.js` | 2 | `../../IStorageProvider.js` | `src/platform/storage/IStorageProvider.js` |
| `src/platform/workflow/WorkflowServiceBase.js` | 16 | `./WorkflowAuthorizationService.js` | `src/platform/workflow/WorkflowAuthorizationService.js` |
| `src/platform/workflow/WorkflowServiceBase.js` | 17 | `./WorkflowMediaService.js` | `src/platform/workflow/WorkflowMediaService.js` |
| `src/use-cases/registerUseCases.js` | 4 | `./definitions/videoGeneration.js` | `src/use-cases/definitions/videoGeneration.js` |
| `tests/boundary/projectOwnershipBoundary.test.js` | 6 | `../../routes/video.js` | `routes/video.js` |
| `tests/boundary/referenceAndMediaOwnershipBoundary.test.js` | 6 | `../../routes/video.js` | `routes/video.js` |

---

## 3. Secrets & Binaries Scan of Uncommitted Files

An automated recursive scan was conducted across all 66 modified and 36 untracked files:
1. **Secrets & Tokens**:
   - **Zero hardcoded credentials, service-role keys, private keys, or passwords were found**.
   - Findings detected were verified as non-secret environment reads (`process.env.WAVESPEED_API_KEY`, `process.env.REDIS_PASSWORD`) or documentation placeholders (`SUPABASE_SERVICE_ROLE_KEY=<service-role-key>`).
2. **Binaries & Large Files**:
   - **Zero binaries or image assets (> 500KB) exist in the working tree**.
   - No `.png`, `.jpg`, `.mp4`, or archive files are pending commit in `apiOpenArt`.
3. **`.gitignore` Coverage**:
   - `.gitignore` properly excludes: `node_modules/`, `.env`, `.env*`, `*.log`, `coverage/`, `dist/`, `build/`, `*.tmp`.
   - Real local environment files (`.env`, `.env.local`) are ignored and not tracked.

---

## 4. Migrations Inventory

| Migration File | Tracked? | Purpose | Code Depending On It | Needed in HEAD + Working Tree? |
| :--- | :---: | :--- | :--- | :---: |
| `003_pricing_rules.sql` | Tracked | Creates `pricing_rules` table for dynamic credit rates | `src/services/pricingService.js` | **YES** |
| `004_failed_wallet_operations.sql` | Tracked | Creates audit log table for failed wallet operations | `src/services/walletService.js` | **YES** |
| `005_subscriptions.sql` | Tracked | Schema for user subscription tiers | `src/services/subscriptionService.js` | **YES** |
| `006_v2_workflow_runs.sql` | Tracked | Base table definition for orchestrator run states | `src/v2/runner/workflowRunner.js` | **YES** |
| `007_v2_workflow_runs_targets.sql` | Tracked | Adds `target_workflow_id`, `target_media_ids` to `v2_workflow_runs` | `src/v2/runner/nodeExecutor.js`, use-case definitions | **YES** |
| `007_v2_workflow_runs_targets_rollback.sql` | Tracked | Reverses migration 007 columns | Rollback maintenance | No (Operational) |
| `20260720_create_element_table.sql` | Tracked | Base schema for `public.element` | `src/db/ElementRepository.js` | **YES** |
| `20260723_element_v1_nullable_patch.sql` | Tracked | Makes non-critical element columns nullable | `src/db/ElementRepository.js` | **YES** |
| `20260726_add_keywords_guidelines_to_element.sql` | Tracked | Historical migration adding `keywords`, `guidelines` | Superseded by 20260924/20260925 | Applied historically |
| `20260730_fix_element_rls.sql` | Tracked | Enables Row Level Security on `public.element` | Supabase RLS | **YES** |
| `20260902_create_usage_events.sql` | Tracked | Creates audit table for billing usage events | `src/services/walletService.js` | **YES** |
| `20260924_drop_element_keywords_tags.sql` | **Untracked** | Drops `keywords` and `tags` columns from `public.element` | `src/db/ElementRepository.js` (removes column queries) | **YES** |
| `20260925_convert_element_guidelines_to_text.sql` | **Untracked** | Converts `guidelines` column from array to plain `TEXT` | `src/db/ElementRepository.js`, `ElementService.js` | **YES** |
| `add_credit_package_metadata.sql` | Tracked | Adds metadata JSON column to credit packages | `routes/payments.js` | **YES** |
| `create_credit_packages.sql` | Tracked | Creates table storing available credit top-up packages | `routes/payments.js` | **YES** |
| `create_workflow_with_placeholder_media.sql` | Tracked | PL/pgSQL function for atomic placeholder creation | `WorkflowRepository.createWithPlaceholderMedia` | **YES** |

---

## 5. `package-lock.json` Analysis

- In Phase 0 Task T1 (`bba5777`), `"rate-limiter-flexible": "^11.2.1"` was added to `package.json`.
- However, `package-lock.json` was omitted from that commit and left unstaged in the working tree.
- When `npm ci` executes on a clean checkout, npm checks that `package-lock.json` matches `package.json` exactly. Because `rate-limiter-flexible` is absent from the committed lockfile, `npm ci` halts with `npm error Missing: rate-limiter-flexible@11.2.1 from lock file`.
- **Resolution**: Committing the modified `package-lock.json` (as part of Commit 6 above) resolves this and allows `npm ci` to succeed cleanly.
