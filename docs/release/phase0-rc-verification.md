# Phase 0 Release Candidate Verification Pack (Staging Readiness)

**Target Release Branch**: `hardening/phase0`  
**Current HEAD SHA**: `507d67f2d0c61cddc2afa21c7f644950c3b3d57a`  
**Base Commit**: `3d3265fe8e4238e8e3d81b945c7ad565e2b0bbdb` (`main`)  
**Date**: 2026-10-05  
**Mode**: READ-ONLY verification & staging readiness report (no production code modifications)

---

## V-A. Frontend Impact Analysis (`my-app/`)

Cross-referenced every client-visible change from `docs/release/phase0-rc.md` against frontend call-sites in `my-app/`.

### Impact Matrix

| Server Change | Frontend Call-Site (File:Line) | What Frontend Sends Today | New Server Behavior | Breaks? | Evidence & Impact |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **Direct image URLs forbidden in references** | `src/shared/lib/referenceUtils.js:120-138` | When reference lacks `workflow_id`/`id`, line 131 falls back to `r.url`: `{ workflow_id: "https://..." }` | Returns **HTTP 400 Bad Request** (`"Direct image URLs are not permitted in references. Use workflow IDs only."`) | **YES** *(Conditional)* | In `referenceUtils.js:131`, `r.url` is used as fallback. If an external or legacy image lacks `workflow_id`/`asset_id`, frontend sends a URL string, which `imageController.js:73` and `videoController.js:70` reject with 400. Fresh uploads from PC via `useMediaUpload.js` receive `{ workflow_id }` and succeed. |
| **404 on foreign / IDOR resources** | `src/features/workflows/api/workflowsApi.js:138`<br>`src/features/prompt-bar/model/usePromptBar.js:234` | Sends `project_id: projectId` and `references: [{ workflow_id }]` | Returns **HTTP 404 Not Found** (`PROJECT_NOT_FOUND` or `Resource not found or access denied`) | **NO** *(Legitimate)*<br>**YES** *(IDOR)* | Normal users owning their project and references receive 200 OK. Cross-tenant access or sharing foreign workflow IDs correctly aborts with clean 404 instead of leaking or operating on foreign records. |
| **429 on Prompt Optimization** | `src/features/prompt-bar/model/usePromptOptimizer.js:29` | Calls `apiClient.post("/prompt/optimize", { prompt, mode })` | Returns **HTTP 429 Too Many Requests** (`RATE_LIMIT_EXCEEDED`) if > 20 req/min | **NO** *(Under normal usage)* | 20 req/min allows 1 prompt optimization every 3 seconds. Rapid automated/spam clicks receive 429. Catch block in `usePromptOptimizer.js:44` sets `error` message cleanly. *(Note: `usePromptOptimizer.js` imports non-existent `@/shared/api/apiClient` instead of `@/shared/api/client`)*. |
| **Count clamp / 422 Contract Violation** | `src/features/prompt-bar/model/usePromptBar.js:233`<br>`src/features/prompt-bar/model/usePromptStore.js:45` | Sends `count: count` (user-selectable 1..4 in UI) | If model does not support multi-candidate generation, server returns **HTTP 422 Unprocessable Entity** (`UNSUPPORTED_CAPABILITY`) or clamps | **YES** *(If UI permits count > 1 on single-image models)* | Models such as `nanobana_2` without multi-candidate capability reject `count > 1` with 422 `UNSUPPORTED_CAPABILITY`. UI must restrict count slider to models advertising `capabilities.count: true`. |
| **500 INTERNAL_ERROR + traceId** | `src/shared/api/client.js:48-52` | Generation requests that fail unexpectedly on server | Returns standardized `{ ok: false, code: "INTERNAL_ERROR", message: "Failed to generate image", traceId: "<uuid>" }` | **NO** | `client.js:50` reads `errorData.message`. It receives the sanitized message without breaking error parsing, and server logs correlate the incident via `traceId`. |
| **503 on Queue Outage** | `src/shared/api/client.js:48-52`<br>`src/features/workflows/api/workflowsApi.js:139` | Generation requests when Redis / BullMQ worker is unreachable | Returns **HTTP 503** `{ ok: false, status: "failed", code: "QUEUE_DISPATCH_FAILED", message: "Generation service temporarily unavailable. Please try again." }` | **NO** | Frontend displays `errorData.message` cleanly. All placeholder rows are transitioned to `status: "failed"` and billing hold is released exactly once. |
| **Disabled Direct Workflow Endpoint (`/api/v2/workflows/run`)** | *None in `my-app`* | Frontend does not call `/api/v2/workflows/run` | Returns **HTTP 404** `ENDPOINT_DISABLED` | **NO** | Frontend exclusively calls domain endpoints (`/images/generated`, `/video/generated`, `/characters/*`, `/v2/elements/*`). Zero impact. |
| **Response Shape Changes** | `src/features/prompt-bar/model/usePromptBar.js:247`<br>`src/features/workflows/api/workflowsApi.js:140` | Expects `{ ok: true, project_id, session_id, workflowId, mediaId }` | Server returns `{ ok: true, status: "processing", workflowId, mediaId, mediaIds, taskId, project_id, session_id, workflow }` | **NO** | Response shape retains backwards compatibility for all required fields (`ok`, `project_id`, `session_id`, `workflowId`, `mediaId`). |

---

## V-B. Comprehensive Pricing Sweep (Real Manifests & Pricing Engine, No Mocks)

Executed an empirical sweep across all **21 models** in the catalog, evaluating all valid parameter permutations that users can configure (resolution/quality, aspect ratio, duration, input image presence, and scaling factors).

### Results Table

| Model ID | Domain | Provider | Parameter Combos Tested | Invalid / Failed Combos | Min Credits | Max Credits | Notes |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| `gemini_2_0_flash` | `llm` | Google | 1 | 0 | 1 | 1 | System LLM (Translation/Safety) |
| `gemini_2_0_flash_lite` | `llm` | Google | 1 | 0 | 1 | 1 | System LLM |
| `gemini_3_1_flash_lite` | `llm` | Google | 1 | 0 | 1 | 1 | Active System LLM for Workflows |
| `gemini_3_5_flash_lite` | `llm` | Google | 1 | 0 | 1 | 1 | System LLM |
| `gemini_3_flash` | `llm` | Google | 1 | 0 | 1 | 1 | System LLM |
| `gemini_flash_lite_latest` | `llm` | Google | 1 | 0 | 1 | 1 | System LLM |
| `gpt_image_2` | `image` | WaveSpeed | 18 | 0 | 8 | 8 | Flat rate (text-to-image & edit) |
| `ltx_2_3_fast` | `video` | LTX | 18 | 0 | 16 | 16 | Text-to-video / Image-to-video |
| `ltx_2_3_pro` | `video` | LTX | 18 | 0 | 35 | 35 | High-fidelity video generation |
| `ltx_2_5_fast` | `video` | LTX | 18 | 0 | 20 | 20 | Next-gen fast video generation |
| `ltx_2_5_pro` | `video` | LTX | 18 | 0 | 40 | 40 | Next-gen pro video generation |
| `ltx_extend` | `video` | LTX | 3 | 0 | 10 | 25 | Video continuation (duration 2s-6s) |
| `ltx_retake` | `video` | LTX | 6 | 0 | 22 | 22 | Video segment regeneration |
| `nanobana_2` | `image` | WaveSpeed | 18 | 0 | 6 | 18 | 1k=6 cr, 2k=12 cr, 4k=18 cr |
| `nanobana_pro` | `image` | WaveSpeed / Google | 18 | 0 | 10 | 30 | 1k=10 cr, 2k=20 cr, 4k=30 cr |
| `nanobana_pro_ultra` | `image` | WaveSpeed | 12 | 0 | 36 | 80 | 2k=36 cr, 4k=54 cr, 8k=80 cr |
| `seedance_2_5` | `video` | WaveSpeed | 36 | 0 | 40 | 45 | T2V (40 cr), I2V (45 cr) |
| `seedance_2_5_extend` | `video` | WaveSpeed | 6 | 0 | 30 | 30 | Video continuation |
| `seedream_v5` | `image` | WaveSpeed | 9 | 0 | 9 | 18 | 1k=9 cr, 2k=18 cr |
| `wan_3_0` | `video` | WaveSpeed | 36 | 0 | 35 | 38 | T2V 5s (35 cr), I2V 5s (38 cr) |
| `wavespeed_upscale` | `upscale` | WaveSpeed | 3 | 0 | 2 | 8 | 2x=2 cr, 4x=4 cr, 8x=8 cr |

### Sweep Summary
- **Total Models Audited**: 21
- **Total Permutations Evaluated**: 248
- **Failed Combos**: 0
- **Undefined, Null, NaN, Negative, or Zero Credits**: Exactly 0 across the entire catalog.
- **Deterministic Symmetry**: All models evaluate deterministic pricing with positive integer credits.

### Model Naming & Aliasing Taxonomy
1. **`gpt-image-2` vs `gpt_image_2`**:
   - The canonical model ID in `src/models/manifests/` is `gpt_image_2`.
   - `src/models/registry/modelRegistry.js:349` automatically normalizes hyphens to underscores (`modelId.replace(/-/g, "_")`). Therefore, `gpt-image-2` transparently resolves to `gpt_image_2`.
2. **`wan-2-1` vs `wan_3_0`**:
   - The canonical catalog ID is `wan_3_0` (Alibaba Wan 3.0), which prices at 35 credits for 5s text-to-video.
   - `wan-2-1` was an incidental label in the F2.5-b report text referring to Wan video generation; `wan-2-1` does not exist in the catalog. The actual evaluated model is `wan_3_0`.
3. **Exposed Model Keys**:
   - **Public Catalog Endpoint (`GET /api/models`)**: Exposes the 15 user-facing models:
     - Images (5): `gpt_image_2`, `nanobana_2`, `nanobana_pro`, `nanobana_pro_ultra`, `seedream_v5`.
     - Videos (9): `ltx_2_3_fast`, `ltx_2_3_pro`, `ltx_2_5_fast`, `ltx_2_5_pro`, `ltx_extend`, `ltx_retake`, `seedance_2_5`, `seedance_2_5_extend`, `wan_3_0`.
     - Upscale (1): `wavespeed_upscale`.
   - **Internal Models**: The 6 `gemini_*` models have `domain: "llm"` and are hidden from the public catalog.

---

## V-C. Environment Variables & Boot Failure Modes

### Environment Variables Audit Table

| Variable | Read Location (File:Line) | Default Value | Behavior in `NODE_ENV=production` if Missing |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `src/container.js:50`<br>`src/models/runtime/providerRuntimeRegistry.js:15, 23` | `undefined` (treated as development) | **FAILS OPEN**: If unset, server treats environment as development. Production boot assertion `assertWalletConfiguredForEnvironment()` is bypassed, allowing the server to boot without database credentials. |
| `SUPABASE_URL` | `src/container.js:44, 51`<br>`lib/supabase.js:5` | `undefined` | **BOOT CRASH (FAIL CLOSED)**:<br>`Error: Fatal: WalletService is required in production (NODE_ENV=production). Missing: SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` *(or `SUPABASE_KEY`)* | `src/container.js:44, 52`<br>`lib/supabase.js:6` | `null` | **BOOT CRASH (FAIL CLOSED)**:<br>`Error: Fatal: WalletService is required in production (NODE_ENV=production). Missing: SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY` |
| `ENABLE_V2_WORKFLOW_RUN_ENDPOINT` | `controllers/v2/workflowsController.js:16` | `undefined` | **FAILS CLOSED**: Endpoint `POST /api/v2/workflows/run` returns HTTP 404 (`ENDPOINT_DISABLED`). Safe default. |
| `RATE_LIMIT_STORE` | `src/middleware/rateLimit.js:22` | `"memory"` | **FAILS OPEN (Cluster Scoping)**: Missing value silently defaults to in-memory rate limiting. Multi-instance production deployments will enforce rate limits per-instance rather than globally across Redis. |
| `INTERNAL_SECRET` | `src/middleware/auth.js:14`<br>`src/domain/project/ProjectReadService.js:373` | `undefined` *(auth.js)*<br>`"openart_internal_s2s_secret_2026"` *(ProjectReadService.js)* | **FAILS OPEN**: In `ProjectReadService.js:373`, if `INTERNAL_SECRET` is unset, it falls back to the hardcoded string `"openart_internal_s2s_secret_2026"`, permitting media ownership bypass for anyone providing that header. |
| `INITIAL_WALLET_BALANCE` / `DEFAULT_WALLET_BALANCE` | `src/platform/billing/WalletService.js:31-33` | `0` | **FAILS CLOSED**: Defaults to 0 credits. New users receive zero free credits unless explicitly configured. |

### Minimum Required Environment Variables for Production Boot
The production deployment **MUST** have the following 4 environment variables set:
1. `NODE_ENV=production`
2. `SUPABASE_URL=https://<project-ref>.supabase.co`
3. `SUPABASE_SERVICE_ROLE_KEY=<service-role-key>`
4. `INTERNAL_SECRET=<strong-random-s2s-secret>` *(Must be set to eliminate the hardcoded fallback in `ProjectReadService.js`)*

---

## V-D. F6 Route Ownership Matrix

Every route registered in `src/api/routes.js` and its mounted route modules:

| HTTP Method & Path | Resource IDs (Params / Body / Query) | Handler | Ownership Checked Before Read/Write? | Evidence (File:Line) |
| :--- | :--- | :--- | :---: | :--- |
| `GET /api/health` | None | `healthRouter` | N/A (Public) | `routes/health.js:7` |
| `POST /api/auth/login` | Body: credentials | `authController.login` | N/A (Public) | `routes/authRoutes.js:8` |
| `GET /api/projects` | None (reads `req.user.id`) | `projectsController.getAll` | **YES** (`.eq("user_id", userId)`) | `controllers/projectsController.js:14` |
| `POST /api/projects` | Body: `project_name` | `projectsController.create` | **YES** (inserts with `user_id`) | `controllers/projectsController.js:53` |
| `PATCH /api/projects/:id` | Param: `id` | `projectsController.update` | **YES** (`.eq("id", id).eq("user_id", userId)`) | `controllers/projectsController.js:101` |
| `DELETE /api/projects/:id` | Param: `id` | `projectsController.remove` | **YES** (`.eq("id", id).eq("user_id", userId)`) | `controllers/projectsController.js:129` |
| `POST /api/sessions` | Body: `project_id` | `sessionsController.create` | **YES** (verifies project ownership) | `controllers/sessionsController.js:31` |
| `PATCH /api/sessions/:id` | Param: `id` | `sessionsController.update` | **YES** (joins `project.user_id === userId`) | `controllers/sessionsController.js:68` |
| `DELETE /api/sessions/:id` | Param: `id` | `sessionsController.remove` | **YES** (joins `project.user_id === userId`) | `controllers/sessionsController.js:100` |
| `GET /api/workflows/library` | Query: `project_id`, `session_id` | `generationsQuery.getUserLibrary` | **YES** (`generationService.getUserLibrary`) | `controllers/generationsQueryController.js:23` |
| `GET /api/workflows/library/:workflow_id` | Param: `workflow_id` | `generationsQuery.getLibraryWorkflowDetail` | **YES** (`getWorkflowDetail(userId, wfId)`) | `controllers/generationsQueryController.js:34` |
| `GET /api/workflows/assets/:project_id` | Param: `project_id` | `generationsQuery.getAssets` | **YES** (`getAssets(userId, projectId)`) | `controllers/generationsQueryController.js:13` |
| `GET /api/workflows/project-data/:project_id` | Param: `project_id` | `projectController.getProjectData` | **YES** (`assertOwns("project", projectId, userId)`) | `controllers/projectController.js:120` |
| `GET /api/workflows/workflow-by-media/:media_id` | Param: `media_id` | `workflowsController.getWorkflowByMedia` | **YES** (`_verifyMediaOwnership`) | `src/domain/project/ProjectReadService.js:371` |
| `POST /api/workflows/detach-media` | Body: `media_id`, `project_id` | `workflowsController.detachMediaToNewWorkflow` | **YES** (`verifyMediaOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:283` |
| `PATCH /api/workflows/workflows/:id` | Param: `id` | `workflowsController.patchWorkflow` | **YES** (`verifyWorkflowOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:68` |
| `PATCH /api/workflows/:id` | Param: `id` | `workflowsController.patchWorkflow` | **YES** (`verifyWorkflowOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:68` |
| `PATCH /api/workflows/workflows/:id/move` | Param: `id`, Body: `project_id` | `workflowsController.moveWorkflow` | **YES** (verifies workflow and target project) | `src/platform/workflow/WorkflowServiceBase.js:238` |
| `PATCH /api/workflows/workflows/:id/like` | Param: `id` | `workflowsController.toggleLike` | **YES** (`verifyWorkflowOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:160` |
| `PATCH /api/workflows/workflows/like` | Body: `workflow_ids` | `workflowsController.bulkToggleLike` | **YES** (`verifyWorkflowOwnershipBulk`) | `src/platform/workflow/WorkflowServiceBase.js:199` |
| `PATCH /api/workflows/workflows/:id/primary-media`| Param: `id`, Body: `media_id` | `workflowsController.setPrimaryMedia` | **YES** (verifies workflow and media) | `src/platform/workflow/WorkflowServiceBase.js:127` |
| `PATCH /api/workflows/items/:id/like` | Param: `id` | `generationsMutation.toggleLike` | N/A (No-op placeholder) | `controllers/generationsMutationController.js:43` |
| `DELETE /api/workflows/workflows/:id` | Param: `id` | `workflowsController.deleteWorkflow` | **YES** (`verifyWorkflowOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:342` |
| `DELETE /api/workflows/:id` | Param: `id` | `workflowsController.deleteWorkflow` | **YES** (`verifyWorkflowOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:342` |
| `DELETE /api/workflows/workflows` (bulk) | Body: `workflow_ids` | `workflowsController.bulkDeleteWorkflows` | **YES** (`verifyWorkflowOwnershipBulk`) | `src/platform/workflow/WorkflowServiceBase.js:377` |
| `DELETE /api/workflows/media/:media_id` | Param: `media_id` | `workflowsController.deleteMedia` | **YES** (`verifyMediaOwnership`) | `src/platform/workflow/WorkflowServiceBase.js:428` |
| `DELETE /api/workflows/items/:id` | Param: `id` | `generationsMutation.deleteItem` | **NO (VULNERABILITY)** | `controllers/generationsMutationController.js:23` |
| `POST /api/images/generated` | Body: `project_id`, `references` | `imageController.generateImage` | **YES** (`assertOwns("project")` & `assertOwnsAny`) | `controllers/imageController.js:98-114` |
| `POST /api/video/generated` | Body: `project_id`, `references` | `videoController.generateVideo` | **YES** (`assertOwns("project")` & `assertOwnsAny`) | `controllers/videoController.js:95-111` |
| `POST /api/characters/create` | Body: `projectId`, `references` | `characterController.createCharacter` | **YES** (`assertOwns("project")` & `assertOwnsAny`) | `src/domain/character/CharacterService.js:79` |
| `PATCH /api/characters/:characterId` | Param: `characterId` | `characterController.updateCharacter` | **YES** (`assertOwns("character")`) | `src/domain/character/CharacterService.js:231` |
| `DELETE /api/characters/:characterId` | Param: `characterId` | `characterController.deleteCharacter` | **YES** (`assertOwns("character")`) | `src/domain/character/CharacterService.js:346` |
| `POST /api/characters/:characterId/generate-sheet`| Param: `characterId`, Body: `projectId` | `characterController.generateCharacterSheet` | **YES** (`assertOwns("character")` & `"project"`) | `src/domain/character/CharacterService.js:416-418` |
| `POST /api/characters/:characterId/media` | Param: `characterId` | `characterController.addMediaToCharacter` | **YES** (`assertOwns("character")`) | `src/domain/character/CharacterService.js:384` |
| `DELETE /api/characters/:characterId/media/:mediaId`| Param: `characterId`, `mediaId` | `characterController.removeMediaFromCharacter` | **YES** (`assertOwns("character")`) | `src/domain/character/CharacterService.js:394` |
| `POST /api/characters/:characterId/sheet-media` | Param: `characterId` | `characterController.setCharacterSheetMedia` | **YES** (`assertOwns("character")`) | `src/domain/character/CharacterService.js:404` |
| `POST /api/v2/elements` | Body: `projectId` | `elementController.createElement` | **YES** (`assertOwns("project")`) | `controllers/elementController.js:52` |
| `GET /api/v2/elements/project/:projectId` | Param: `projectId` | `elementController.getElementsByProject` | **YES** (`assertOwns("project")`) | `controllers/elementController.js:86` |
| `GET /api/v2/elements/:id` | Param: `id` | `elementController.getElementById` | **YES** (`assertOwns("element")`) | `controllers/elementController.js:109` |
| `PATCH /api/v2/elements/:id` | Param: `id` | `elementController.updateElement` | **YES** (`assertOwns("element")`) | `controllers/elementController.js:137` |
| `DELETE /api/v2/elements/:id` | Param: `id` | `elementController.deleteElement` | **YES** (`assertOwns("element")`) | `controllers/elementController.js:160` |
| `POST /api/v2/elements/:id/images` | Param: `id` | `elementController.addImages` | **YES** (`assertOwns("element")`) | `controllers/elementController.js:191` |
| `POST /api/v2/elements/analyze` | Body: `id` | `elementController.analyzeElement` | **YES** (`assertOwns("element")`) | `controllers/elementController.js:217` |
| `POST /api/assets/upload` | Body: `project_id`, `session_id` | `mediaIngestionService.ingest` | **YES** (`mediaIngestionService.ingest`) | `routes/assets.js:35` |
| `DELETE /api/assets/:id` | Param: `id` | `workflowService.deleteMedia` | **YES** (`verifyMediaOwnership`) | `routes/assets.js:73` |
| `POST /api/media/ingest` | Body: `project_id`, `session_id`, `workflow_id` | `mediaIngestionService.ingest` | **YES** (`verifyMediaOwnership`) | `routes/mediaIngestRoutes.js:39` |
| `GET /api/wallet/balance` | None (reads `req.user.id`) | `walletController.getBalance` | **YES** (scoped to user) | `routes/wallet.js:26` |
| `GET /api/wallet/transactions` | None (reads `req.user.id`) | `walletController.getTransactions` | **YES** (scoped to user) | `routes/wallet.js:29` |
| `POST /api/prompt/optimize` | None (reads `req.user.id`) | `promptController.optimizePrompt` | **YES** (authenticated + billed to user) | `routes/prompt.js:10` |
| `POST /api/v2/workflows/run` | None | `v2WorkflowsController.runWorkflow` | N/A (Disabled: returns 404) | `controllers/v2/workflowsController.js:17` |

### Critical Route Ownership Findings
1. **`DELETE /api/workflows/items/:id`**: Calls `deleteOne("collection_items", req.params.id)` with zero ownership check. An authenticated user can delete any collection item by ID.
2. **`ProjectRepository.findAll()`**: Defined in `src/db/ProjectRepository.js:18`, but **never called** by any controller or route handler. No endpoint returns other tenants' project lists.
3. **Presets / Public Concepts**:
   - Characters: Strictly private (`user_id` enforced).
   - Elements: Strictly private (`user_id` enforced).
   - Templates: System-level static YAML workflow definitions (`image-generation-v1`, `video-generation-v1`, `character-sheet-v1`). No tenant-writable templates exist.

---

## V-E. Git & Release Candidate Status

1. **Working Tree Status**:
   - Working tree has untracked and unstaged modifications from repository development prior to Phase 0.
   - All Phase 0 commits (1 through 30) are cleanly recorded on branch `hardening/phase0`.
2. **Remote Branch Status**:
   - Branch `hardening/phase0` **DOES NOT EXIST** on the remote repository (`origin`).
   - `git branch -r` shows only:
     ```text
     origin/HEAD -> origin/main
     origin/main
     ```
   - No push has been performed.
3. **Exact Release Candidate Tag**:
   - **Recommended Tag**: `phase0-rc1`
   - **Target Commit SHA**: `507d67f2d0c61cddc2afa21c7f644950c3b3d57a`
   - **Commit Subject**: `phase0(F2.5-d): create Phase 0 Release Candidate documentation`
   *(Tag has not been created per instructions).*
