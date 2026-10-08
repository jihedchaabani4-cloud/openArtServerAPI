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
- [High] src/domain/project/ProjectReadService.js:62 | lets projects with user_id NULL be read by any user (assertOwns rejects, but ProjectReadService check is permissive) | found during PREP-P3
- [High] src/platform/security/ownership.js | Route ownership audit covers only URL parameters (:id), not IDs provided in JSON request bodies (e.g. folderId, projectId, sessionId). Protection for body IDs relies on manual service/controller checks | found during P3 audit
- [High] routes/assets.js:52 (POST /upload) | session_id parameter in request body is forwarded directly to MediaIngestionService / WorkflowRepository.createWorkflow without ownership or project scoping checks, allowing potential cross-tenant / IDOR session linkage | found during P3 audit

## Workflow Media Follow-ups
- [Medium] src/db/workflowMediaLinker.js | relation write failures are warning-only during additive rollout; revisit after migration 009 is deployed everywhere | found during WM-T2
- [Medium] src/db/MediaRepository.js | WM-T3 must make read paths prefer workflow_media while preserving legacy response fields | found during WM-T2

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
