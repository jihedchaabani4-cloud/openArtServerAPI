# Backlog

## Resolved in D3(4) (Ownership Test Suites Migration)
> **Resolution Summary**: These 20 legacy tests previously failed with `401 !== 404` (or `401 !== 200`) because their test harnesses used `x-internal-secret` on non-allowlisted routes. In D3(4), their test harnesses were migrated to use standard mock JWT authentication (`Authorization: Bearer token-user-X`) with mock `supabase.auth.getUser`. All cross-tenant checks assert HTTP 404 with unrevealed response bodies, and legitimate owner checks assert HTTP 200. All 20 tests are now 100% PASSING.

- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 1: Character Sheet: User B on User A's character returns 404 and prevents sheet generation
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 2: Character Update: User B on User A's character returns 404 and prevents mutation
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 3: Character Delete: User B on User A's character returns 404 and prevents deletion
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 4: Element Read: User B on User A's element returns 404
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 5: Element Update: User B on User A's element returns 404 and prevents mutation
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 6: Element Delete: User B on User A's element returns 404 and prevents deletion
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 7: Element List: User B on User A's project returns 404
- [RESOLVED in D3(4)] tests/boundary/characterAndElementOwnershipBoundary.test.js | TEST 8: Character & Element: Legitimate owner User A operations succeed
- [RESOLVED in D3(4)] tests/boundary/collectionItemOwnershipBoundary.test.js | TEST 1: Foreign user calling DELETE /api/workflows/items/:id gets 404 and item is NOT deleted
- [RESOLVED in D3(4)] tests/boundary/collectionItemOwnershipBoundary.test.js | TEST 2: Owner calling DELETE /api/workflows/items/:id succeeds with 200
- [RESOLVED in D3(4)] tests/boundary/collectionItemOwnershipBoundary.test.js | TEST 3: Foreign user calling PATCH /api/workflows/items/:id/like gets 404
- [RESOLVED in D3(4)] tests/boundary/collectionItemOwnershipBoundary.test.js | TEST 4: Owner calling PATCH /api/workflows/items/:id/like succeeds with 200
- [RESOLVED in D3(4)] tests/boundary/projectOwnershipBoundary.test.js | TEST 1: Image: User B using User A's projectId returns 404 and creates NO workflow/media/hold
- [RESOLVED in D3(4)] tests/boundary/projectOwnershipBoundary.test.js | TEST 2: Video: User B using User A's projectId returns 404 and creates NO workflow/media/hold
- [RESOLVED in D3(4)] tests/boundary/projectOwnershipBoundary.test.js | TEST 3: Image: Legitimate project owner (User A) using proj-user-A succeeds with 200
- [RESOLVED in D3(4)] tests/boundary/projectOwnershipBoundary.test.js | TEST 4: Video: Legitimate project owner (User A) using proj-user-A succeeds with 200
- [RESOLVED in D3(4)] tests/boundary/referenceAndMediaOwnershipBoundary.test.js | TEST 1: Image Gen: User B referencing User A's character returns 404 and prevents generation
- [RESOLVED in D3(4)] tests/boundary/referenceAndMediaOwnershipBoundary.test.js | TEST 2: Image Gen: User B using User A's media as input_image returns 404 and prevents generation
- [RESOLVED in D3(4)] tests/boundary/referenceAndMediaOwnershipBoundary.test.js | TEST 3: Video Gen: User B using User A's media as input_image or references returns 404 and prevents generation
- [RESOLVED in D3(4)] tests/boundary/referenceAndMediaOwnershipBoundary.test.js | TEST 7: Legitimate Owner: User A referencing own character and media succeeds

## High Severity
- [RESOLVED in phase6(OWN-IMG-2)] controllers/imageController.js:115, controllers/videoController.js:117, src/v2/nodes/imageGenerationNode.js:66, src/v2/nodes/videoGenerationNode.js:101 | Media parameter ownership gap when `parameters.images`, `reference_images`, `reference_videos`, `input_image`, `last_frame`, `input_video`, or top-level `references` is sent as a string or object instead of an array | Fixed via shared `toMediaIdList(value)` helper (Decision D-28)
- [High] controllers/imageController.js:86-93,118 & controllers/videoController.js:85-92,120 & src/v2/nodes/imageGenerationNode.js:69 & src/v2/nodes/videoGenerationNode.js:104 | Values starting with `http://` or `https://` inside array/object media parameters (`parameters.images = ["https://..."]` or `[{ url: "https://..." }]`) bypass top-level string URL check (400) and ownership check (`!mediaRefId.startsWith("http")`) and are forwarded to upstream AI providers without a host allow-list | found during OWN-IMG-1 (read-only per prompt)
- [High] src/domain/project/ProjectReadService.js:62 | lets projects with user_id NULL be read by any user (assertOwns rejects, but ProjectReadService check is permissive) | found during PREP-P3
- [High] src/platform/security/ownership.js | Route ownership audit covers only URL parameters (:id), not IDs provided in JSON request bodies (e.g. folderId, projectId, sessionId). Protection for body IDs relies on manual service/controller checks | found during P3 audit
- [High] routes/assets.js:52 (POST /upload) | session_id parameter in request body is forwarded directly to MediaIngestionService / WorkflowRepository.createWorkflow without ownership or project scoping checks, allowing potential cross-tenant / IDOR session linkage | found during P3 audit

## Workflow Media & Schema Follow-ups
- [Medium] validator accepts string for array parameters; decide strict 400 vs tolerance after checking real API clients (`src/models/schema/schemaValidator.js:127-149`) | found during OWN-IMG-2
- [Medium] src/domain/character/CharacterService.js:441 & src/domain/character/CharacterGenerationService.js:108 | `references: Array.isArray(references) ? references : []` drops non-array `references` and does not run `assertOwnsAny` on `references` before enqueueing `character-sheet-v1` | found during OWN-IMG-2 sweep
- [Low] src/v2/nodes/safety/NodeSafetyService.js:109,153 | `Array.isArray(inputs.images)` and `Array.isArray(inputs.references)` only accept arrays for internal V2 LLM / PromptBuilder node inputs | found during OWN-IMG-2 sweep
- [Medium] src/db/workflowMediaLinker.js | relation write failures are warning-only during additive rollout; revisit after migration 009 is deployed everywhere | found during WM-T2
- [Medium] src/db/MediaRepository.js | WM-T3 must make read paths prefer workflow_media while preserving legacy response fields | found during WM-T2
- [Medium] src/v2/resolvers/WorkflowReferenceResolver.js | WM-T4 must migrate character/element/reference resolution to prefer role fields while retaining step_id compatibility | found during WM-T3


## Remaining Pre-existing Failures (9 total)

### Medium Severity (Execution & Feature Flags)
- [Medium] tests/boundary/v2WorkflowRunBoundary.test.js | TEST 1: Default config: POST /api/v2/workflows/run is disabled and returns 404 | Cause: dark v2 endpoint route mounting/behavior mismatch
- [Medium] tests/boundary/v2WorkflowRunBoundary.test.js | TEST 2: Feature flag enabled: allows execution only when ENABLE_V2_WORKFLOW_RUN_ENDPOINT=true | Cause: dark v2 endpoint route mounting/behavior mismatch
- [Medium] tests/boundary/v2WorkflowRunBoundary.test.js | TEST 3: GET /runs/:run_id returns 404 when requested by a different user | Cause: dark v2 endpoint route mounting/behavior mismatch

### Low Severity (Count Clamping, Rate Limit Harness, Legacy Health Output)
- [Low] tests/boundary/countBehaviorBoundary.test.js | TEST 1: top-level count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200 | Cause: mock model pricing/count clamp return mismatch
- [Low] tests/boundary/countBehaviorBoundary.test.js | TEST 2: parameters.count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200 | Cause: mock model pricing/count clamp return mismatch
- [Low] tests/boundary/countBehaviorBoundary.test.js | TEST 3: count: 4 on all catalog image models (gpt_image_2, seedream_v5, nanobana_pro) — all clamp silently to 1 | Cause: mock model pricing/count clamp return mismatch
- [Low] tests/boundary/promptOptimizationBoundary.test.js | TEST 3: Identity & Billing: forwards authenticated userId to promptService | Cause: test sends internal secret to prompt route; blocked by auth.js with 401
- [Low] tests/boundary/promptOptimizationBoundary.test.js | TEST 5: Rate Limiting: blocks requests exceeding limit with 429 and Retry-After | Cause: test sends internal secret to prompt route; blocked by auth.js with 401
- [Low] tests/boundary/uploadHardeningD25Boundary.test.js | /health endpoint exposes redis readiness status without crashing | Cause: legacy D2.5 assertion expects data.redis in /health, which was cleanly moved to /ready in D2.6 (Decision D-10)
- [Low] src/domain/element/ElementMediaService.js | `resolveAsElement` returns all media URLs without role-based sheet/reference separation; could add role-based split in future | found during WM-T4
- [Low] src/platform/workflow/WorkflowServiceBase.js:280,291,298 | pre-existing `console.warn` calls should be migrated to structured logger | found during WM-T4
