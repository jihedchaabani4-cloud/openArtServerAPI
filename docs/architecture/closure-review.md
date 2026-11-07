# Business Systems Closure Audit: Storage and Billing

> **Audit Date**: 2026-11-03  
> **Status**: REPORT ONLY (No production code changes applied, no commits created).  
> **Audited Targets**: Storage System (Phases 1, 2.1, 2.2a, 2.2b-1, 2.2b-2a, 2.2b-2b, 2.3, Clean Code follow-up) & Billing System (Phases 2.1 to 2.5).

---

## 1. Phase Commitment Audit Matrix

| Phase | Commit Hash | Files Changed (Tracked? Yes/No) | Behavior Change (Yes/No, Which) | Tests Added | Known Shortcuts / Accepted Debt | What I Should Re-Check |
|---|---|---|---|---|---|---|
| **Storage 1** | `b37113b` | 14 files (`docs/agents/service-catalog.md`, `src/platform/storage/StoragePathResolver.js`, `StorageService.js`, `index.js`, `mediaStorageService.js`, `providers/InMemoryStorageProvider.js`, `providers/SupabaseStorageProvider.js`, `src/services/storage/providers/SupabaseStorageProvider.js`, `src/utils/storagePath.js`, 4 boundary tests, `tests/unit/storageServiceContract.test.js`) — **Tracked: Yes** | **No** (Contract isolation & provider decoupling without altering existing upload/delete semantics) | `tests/unit/storageServiceContract.test.js` (21 tests) | Internal classes exported from barrel (`index.js`). Positional args retained. | Backward compatibility with legacy storage callers. |
| **Storage 2.1** | `ab011b6` | 2 files (`package.json`, `src/container.js`) — **Tracked: Yes** | **Yes** (Wildcard `#platform/storage/*.js` removed; exact `#platform/storage` -> `index.js` mapped) | `0` (re-verified existing test suite) | Deep imports barred via package alias; `src/container.js` uses barrel. | Container wiring to singleton export. |
| **Storage 2.2a** | `b3e22eb` | 4 files (`src/platform/storage/StorageErrors.js`, `StoragePathResolver.js`, `StorageService.js`, `tests/unit/storageServiceContract.test.js`) — **Tracked: Yes** | **Yes** (Replaced `CrudServiceError` & bare `Error` with `StorageValidationError`; HTTP 500 masked -> HTTP 400 typed) | `tests/unit/storageServiceContract.test.js` (+1 test) | Preserved legacy property `errorCode = "VALIDATION_ERROR"` for route compatibility. | Error payload structure on 400 rejections. |
| **Storage 2.2b-1** | `7850db4` | 3 files (`src/platform/storage/StorageService.js`, `src/platform/storage/index.js`, `tests/unit/storageServiceContract.test.js`) — **Tracked: Yes** | **Yes** (Removed unused `storageService` singleton export; marked `deleteByUrl` as `@deprecated`) | `0` (re-verified contract tests) | Retained `deleteByUrl` as deprecated wrapper around `delete(key)`. | Call sites still using `deleteByUrl`. |
| **Storage 2.2b-2a** | `be13e60` | 2 files (`src/platform/storage/index.js`, `tests/unit/storageServiceContract.test.js`) — **Tracked: Yes** | **Yes** (Pruned `StoragePathResolver`, `IStorageProvider`, `SupabaseStorageProvider` from barrel) | `0` (migrated contract test imports to internal relative paths) | Barrel surface tightened to facade, error classes, and test-only memory provider. | Verify external consumers only import from barrel. |
| **Storage 2.2b-2b** | `036ce6d` | 6 files (`src/container.js`, `src/platform/storage/StorageService.js`, `src/platform/storage/index.js`, `providers/SupabaseStorageProvider.js`, `src/platform/storage/storageFactory.js`, `tests/unit/storageServiceContract.test.js`) — **Tracked: Yes** | **Yes** (Removed `supabaseAdmin` fallback; constructor fails closed without provider; added factory) | `tests/unit/storageServiceContract.test.js` (+1 test) | Dual-signature constructor retained (`(bucket, provider)` vs `{ bucketName, provider }`) for test backward compatibility. | Ensure all runtime production wiring goes through `createStorageService`. |
| **Storage 2.3** | `66dc827` | 5 files (`src/container.js`, `src/domain/asset/AssetUploadService.js`, `src/domain/character/CharacterService.js`, `src/domain/element/ElementService.js`, `src/infrastructure/storage/workflowStorageGateway.js`) — **Tracked: Yes** | **No** (Pruned dead `storageService` constructor parameters and container wiring) | `0` (re-verified domain service unit tests) | Did not run `npm run catalog` in commit `66dc827`, leaving `service-catalog.md` stale until follow-up. | Verify domain services operate without storage injection. |
| **Storage Follow-up (Clean Code)** | `6e78ca0` | 3 files (`src/platform/storage/StorageService.js`, `src/platform/storage/providers/SupabaseStorageProvider.js`, `src/platform/storage/streamUtils.js`) — **Tracked: Yes** | **No** (Extracted stream utility `isStream` and pruned dead code) | `0` (full hermetic test suite passing) | `service-catalog.md` remained stale at commit HEAD `6e78ca0`. | Verify `streamUtils.js` is tracked in git. |
| **Billing 2.1** | `688eeb3` | 14 files (`arch-baseline.json`, `controllers/adminController.js`, `controllers/walletController.js`, `docs/agents/service-catalog.md`, `package.json`, `src/container.js`, `src/platform/billing/BillingErrors.js`, `FailedOpsService.js`, `PricingService.js`, `UsageEventRepository.js`, `WalletService.js`, `index.js`, `src/workers/walletWorker.js`, `tests/unit/billingContract.test.js`) — **Tracked: Yes** | **Yes** (Wildcard `#platform/billing/*.js` removed; exact `#platform/billing` alias created; `BillingError` hierarchy introduced) | `tests/unit/billingContract.test.js` (18 tests) | `WalletService.js` throws custom error inheriting `BillingError`. | Barrel capability function signatures. |
| **Billing 2.2** | `43942e2` | 10 files (`docs/agents/service-catalog.md`, `src/container.js`, `src/platform/billing/FailedOpsService.js`, `WalletService.js`, `billingFactory.js`, `index.js`, `repositories/FailedOpsRepository.js`, `repositories/TransactionRepository.js`, `repositories/WalletRepository.js`, `tests/unit/billingRepositories.test.js`) — **Tracked: Yes** | **Yes** (Injected private repositories; eliminated direct `createClient` instantiations in services) | `tests/unit/billingRepositories.test.js` (12 tests) | Added mutable `.supabase` getter/setter on `WalletService` for backward-compatible test mocks. | Verify services only access DB via repositories. |
| **Billing 2.3** | `07046c5` | 5 files (`docs/agents/service-catalog.md`, `src/container.js`, `src/models/pricing/PricingService.js`, `src/platform/billing/index.js`, `tests/boundary/walletWorkerReaperReconciliationBoundary.test.js`) — **Tracked: Yes** | **Yes** (Relocated `PricingService.js` to `src/models/pricing/` under Models system; purged from Billing barrel) | `0` (updated test import paths) | Relocated file without extracting separate `PricingRuleRepository`. | Authoritative pricing calculation in Models. |
| **Billing 2.4** | `c8ad63b` | 7 files (`controllers/payments/paymentsUtils.js`, `controllers/paymentsController.js`, `src/container.js`, `src/platform/billing/billingFactory.js`, `src/platform/billing/index.js`, `src/platform/billing/repositories/CreditPackageRepository.js`, `tests/unit/billingRepositories.test.js`) — **Tracked: Yes** | **Yes** (Encapsulated `public.credit_packages` in `CreditPackageRepository`; purged raw SQL from payments controller) | `tests/unit/billingRepositories.test.js` (+6 tests) | Added mutable `.supabase` getter/setter on `CreditPackageRepository`; `container.js:152` mutates it with anon client. | Ensure payment webhooks resolve credit packages via Billing barrel. |
| **Billing 2.5** | `537bde0` | 3 files (`arch-baseline.json`, `docs/agents/service-catalog.md`, `src/services/walletService.js`) — **Tracked: Yes** | **No** (Annotated `src/services/walletService.js` as test double; ratcheted arch-baseline from 72 to 71 entries) | `0` (architecture ratchet test) | Test double `src/services/walletService.js` retained in repo for unit tests. | Verify production code imports `#platform/billing`, not legacy service. |

---

## 2. Storage System Audit

### 2.1 Git Worktree & Gate Run at Last Storage Commit (`6e78ca0`)

A clean, detached git worktree was established at HEAD of the last storage commit (`6e78ca0`) at `open art/storage-audit.tmp` with clean `npm ci`:

- **Command**: `npm run gate`
- **Output**:
  ```
  --- service catalog up to date ---
  service-catalog.md is stale or missing. Run: npm run catalog   (and commit the result)

  === GATE SUMMARY ===
  PASS  arch-check (no new violations)
  FAIL  service catalog up to date
  PASS  doc paths exist
  PASS  secrets scan (staged diff)  nothing staged
  PASS  npm test (full hermetic suite)  tests=1195 pass=1195 fail=0 skipped=0
  RESULT: FAIL
  ```
- **Test Count**: 1195 total tests, 1195 passed, 0 failed, 0 skipped.
- **ERR_MODULE_NOT_FOUND Errors**: 0 (zero module resolution failures).
- **Tracked Files Confirmation**:
  - `src/platform/storage/storageFactory.js`: **Tracked** (confirmed in `6e78ca0` via `git ls-tree`).
  - `src/platform/storage/streamUtils.js`: **Tracked** (confirmed in `6e78ca0` via `git ls-tree`).
- **Audit Finding**: `npm run gate` failed strictly on `service catalog up to date` because `service-catalog.md` was not regenerated when `storageService` was pruned from domain services in Phase 2.3 (`66dc827`) and `6e78ca0`.

### 2.2 Security Path Mutation Check

In the throwaway worktree at commit `6e78ca0`, each security check in `src/platform/storage/StorageService.js` was temporarily mutated and tested against the full hermetic test suite:

| Security Check | Mutated Code | Test Suite Result | Failing Tests |
|---|---|---|---|
| **MZ Check** | `buffer[0] === 0x4d && buffer[1] === 0x5a` -> `false` | **FAIL (3 tests)** | 1. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:199:5` (`TEST D2.3-a4: User-upload path strictly rejects dangerous payloads`)<br>2. `tests/boundary/uploadHardeningD24Boundary.test.js:209:5` (`rejects dangerous types (HTML, SVG, ZIP, EXE, ELF) even in provider-output path`)<br>3. `tests/unit/storageServiceContract.test.js:243:5` (`StorageValidationError conforms to StorageError, AppError, and catches MZ executable sniffing`) |
| **ELF Check** | `buffer[0] === 0x7f && buffer[1] === 0x45...` -> `false` | **FAIL (1 test)** | 1. `tests/boundary/uploadHardeningD24Boundary.test.js:209:5` (`rejects dangerous types (HTML, SVG, ZIP, EXE, ELF) even in provider-output path`) |
| **SVG / XML Check** | `headerText.includes("<svg")...` -> `false` | **PASS (0 tests failed!)** | **VULNERABILITY GAP DETECTED**: No test failed! Existing test payloads for SVG (`uploadHardeningAndSniffBoundary.test.js:199` and `uploadHardeningD24Boundary.test.js:86`) both used `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`. Because the preceding script-markup check matches `<script`, it throws first, masking the SVG check. Pure XML/SVG payloads without `<script>` are untested in StorageService. |
| **ZIP Check** | `buffer[0] === 0x50 && buffer[1] === 0x4b` -> `false` | **FAIL (2 tests)** | 1. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:199:5` (`TEST D2.3-a4: User-upload path strictly rejects dangerous payloads`)<br>2. `tests/boundary/uploadHardeningD24Boundary.test.js:209:5` (`rejects dangerous types even in provider-output path`) |
| **Script-Markup Check** | `headerText.includes("<!doctype")...` -> `false` | **FAIL (3 tests)** | 1. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:199:5` (`TEST D2.3-a4`)<br>2. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:248:5` (`TEST D2.3-a6: Provider-output path still strictly rejects dangerous types`)<br>3. `tests/boundary/uploadHardeningD24Boundary.test.js:209:5` (`rejects dangerous types even in provider-output path`) |
| **Declared vs Detected MIME Mismatch** | `declaredMime !== detectedMime` -> `false` | **FAIL (1 test)** | 1. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:184:5` (`TEST D2.3-a3: User-upload path rejects when declared MIME does NOT match real format`) |

- **Post-Mutation Verification**: All files reverted cleanly via `git checkout`; clean tree confirmed; throwaway worktree removed.

### 2.3 `StorageService` Constructor Dual-Signature Audit

The constructor of `StorageService` (`src/platform/storage/StorageService.js:248-265`) accepts:
1. Modern options object: `new StorageService({ bucketName, provider })`
2. Legacy positional parameters: `new StorageService(bucketName, legacyProvider)`

#### Call-Site Audit:
- **Production Code**: **0 occurrences** of legacy positional signature. In production, `src/platform/storage/storageFactory.js:30` constructs `StorageService` exclusively using `{ bucketName, provider }`.
- **Test Code**: **19 occurrences** across 10 test files using positional arguments:
  1. `tests/boundary/authHardeningD26Boundary.test.js:626`
  2. `tests/boundary/ssrfSourcePolicyBoundary.test.js:31`
  3. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:171`
  4. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:186`
  5. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:201`
  6. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:221`
  7. `tests/boundary/uploadHardeningAndSniffBoundary.test.js:250`
  8. `tests/boundary/uploadHardeningD24Boundary.test.js:151`
  9. `tests/boundary/uploadHardeningD24Boundary.test.js:211`
  10. `tests/boundary/uploadHardeningD25Boundary.test.js:179`
  11. `tests/boundary/uploadHardeningD25Boundary.test.js:198`
  12. `tests/unit/mediaServiceContract.test.js:143`
  13. `tests/unit/mediaUploadServiceAndPolicy.test.js:638`
  14. `tests/unit/storagePathFolderSegment.test.js:75`
  15. `tests/unit/storageServiceContract.test.js:29`
  16. `tests/unit/storageServiceContract.test.js:139`
  17. `tests/unit/storageServiceContract.test.js:166`
  18. `tests/unit/storageServiceContract.test.js:257`
  19. `tests/unit/uploadPipelineAndPolicy.test.js:53`

- **Record in `docs/architecture/systems/storage.md`**: Recorded as accepted technical debt in Section 13 with the exact condition that positional parameters may only be removed once all 19 test sites migrate to `{ bucketName, provider }` or `createStorageService`.

### 2.4 HTTP Client Visibility for `StorageValidationError`

- **Status Code**: `400`
- **Error Code (`errorCode`)**: `"VALIDATION_ERROR"` (mapped via `safePublicRouteError.js:22` and preserved legacy alias `StorageValidationError.prototype.errorCode = "VALIDATION_ERROR"`).
- **Public Message (`error`)**: Passes through the raw thrown message string:
  - In `StorageService.js`, messages are explicitly prefixed:
    - `"[StorageService] Executable binary payload (MZ) detected. Ingestion rejected."`
    - `"[StorageService] Executable ELF binary detected. Ingestion rejected."`
    - `"[StorageService] HTML / Script markup payload detected. Ingestion rejected."`
    - `"[StorageService] SVG / XML markup payload detected. Vector graphics and scriptable XML are not permitted in raster image ingestion."`
    - `"[StorageService] ZIP archive payload (PK) detected. Ingestion rejected."`
    - `"[StorageService] Dangerous MIME type \"...\" rejected for provider output."`
    - `"[StorageService] Content inspection failed: declared MIME \"...\" does not match file bytes (\"...\")."`
  - In `StoragePathResolver.js:48`, the message lacks the prefix:
    - `"Invalid storage folder \"...\": must be one of allowed storage folders."`
- **HTTP Response Payload Structure**:
  ```json
  {
    "ok": false,
    "errorCode": "VALIDATION_ERROR",
    "error": "[StorageService] Executable binary payload (MZ) detected. Ingestion rejected."
  }
  ```
- **Upload Route Boundary Note**: In standard media uploads (`POST /api/media/upload`), `MediaInspector` intercepts executable/script payloads upfront as HTTP 415 (`UNSUPPORTED_MEDIA_TYPE`), and `MediaUploadService._uploadSingleOptimizedItem` wraps storage upload errors into `UploadError` (HTTP 502 `STORAGE_UPLOAD_ERROR`). Direct 400 `StorageValidationError` responses appear when calls bypass `MediaInspector` or reach endpoints with direct `StorageService` calls.

---

## 3. Billing System Audit

### 3.1 Clean-Checkout Proof at Last Billing Commit (`537bde0`)

A clean, detached git worktree was established at HEAD of the last billing commit (`537bde0`) at `open art/billing-audit.tmp` with clean `npm ci`:

- **Command**: `npm run gate`
- **Output**:
  ```
  === GATE SUMMARY ===
  PASS  arch-check (no new violations)
  PASS  service catalog up to date
  PASS  doc paths exist
  PASS  secrets scan (staged diff)  nothing staged
  PASS  npm test (full hermetic suite)  tests=1235 pass=1235 fail=0 skipped=0
  RESULT: PASS
  ```
- **Test Count**: 1235 total tests, 1235 passed, 0 failed, 0 skipped.
- **Result**: Complete gate PASS on clean checkout.

### 3.2 Money-Flow Test Coverage Matrix

| Financial Scenario | Test Name / Location | Status | Details / Audit Finding |
|---|---|---|---|
| **Double commit same `reference_id`** | *None* | **NOT COVERED** | Boundary test `useCaseWorkflowAndSettlementBoundary.test.js:429` mocks `commitHoldIdempotent` to return canned `{ status: "COMPLETED" }`. No test invokes `WalletService.commitHoldIdempotent` twice with the same `referenceId` against the real service or repository mock to prove that the second call is a no-op without double-debiting. |
| **Release after commit** | *None* | **NOT COVERED** | No test invokes `WalletService.rollbackHoldIdempotent` or `rollbackCredits` against an already-`COMPLETED` transaction to verify that releasing a settled transaction fails cleanly or is rejected without corrupting balances. |
| **Reaper vs in-flight hold** | `tests/boundary/atomicWalletHoldRPCsBoundary.test.js:274`<br>(`TEST 11`), `TEST 7:155`, `TEST 10:239` | **COVERED** | `TEST 11` simulates a race where reaper marks hold `FAILED` first, proving `extendHold` rejects. `TEST 7` verifies reaper returns 0 when all active holds have `expires_at > now()`. `TEST 10` tests concurrency with SKIP LOCKED simulation. |
| **FailedOps retry after repository move** | *None* | **NOT COVERED** | `tests/unit/billingRepositories.test.js:304` tests `FailedOpsRepository` CRUD in isolation (insert, markCompleted, markAbandoned). However, `FailedOpsService` retry scheduling, exponential backoff calculation (`NOW() + 1m * 2^retry`), and worker execution (`handleRetryFailedOps`) have zero test coverage. |

### 3.3 The `.supabase` Getter/Setter Audit

#### `WalletService.prototype.supabase`
- **Definition**: `src/platform/billing/WalletService.js:55-63`. Setting `wallet.supabase = client` cascades to `this.walletRepo.supabase = client` and `this.txRepo.supabase = client`.
- **Production Code Setting It**: **0 occurrences** (only constructor internal fallback initialization).
- **Test Code Depending on It**: **15 occurrences** across 2 test files:
  - `tests/boundary/atomicWalletHoldRPCsBoundary.test.js`: 14 occurrences (lines 35, 68, 93, 116, 146, 166, 190, 222, 260, 263, 303, 326, 355, 374)
  - `tests/unit/sheetGenerationWorkflowMediaRealService.test.js`: 1 occurrence (line 525)

#### `CreditPackageRepository.prototype.supabase`
- **Definition**: `src/platform/billing/repositories/CreditPackageRepository.js:24-30`.
- **Test Code Depending on It**: **0 occurrences**. All repository tests pass `client` into the constructor `new CreditPackageRepository(client)`.
- **Production Code Setting It**: **1 OCCURRENCE IN CONTAINER WIRING**:
  - `src/container.js:151-153`:
    ```javascript
    export const creditPackageRepo = billingRepos?.creditPackageRepo || null;
    if (creditPackageRepo && supabase) {
        creditPackageRepo.supabase = supabase;
    }
    ```
  - **Audit Finding**: `billingRepos` instantiates `CreditPackageRepository` with `_supabaseForBilling` (the `service_role` client). Immediately after, `src/container.js:152` overwrote `creditPackageRepo.supabase` with `supabase` (both share `SUPABASE_SERVICE_ROLE_KEY` in `lib/supabase.js`; service-role bypasses RLS). This runtime mutation was resolved in commit `20f6f47` by requiring `catalogClient` injection at construction.

### 3.4 Pricing Ownership & Cross-System Import Boundary

- **Authoritative Ownership of `pricing_rules`**:
  - Owned exclusively by the **Models** system (`src/models/pricing/PricingService.js:60, 110`).
  - Table `public.pricing_rules` queries exist only inside `src/models/pricing/PricingService.js`.
- **Authoritative Ownership of `updatePricingRule`**:
  - Controller method in `controllers/adminController.js:217` mounted on route `routes/admin.js:46`.
  - It invokes `req.pricingService.updateRule(id, parsed.data)`, which calls `PricingService` in `src/models/pricing/`.
- **Imports Between `src/platform/billing/**` and `src/models/**`**:
  - `src/platform/billing/**` -> `src/models/**`: **0 imports** (confirmed via git grep).
  - `src/models/**` -> `src/platform/billing/**`: **0 imports** (confirmed via git grep).
  - **Via `src/container.js`**: `PricingService` and `WalletService` are instantiated completely independently. Neither receives the other. The only component that receives both is `UseCaseService` (`src/container.js:220`), which is an Application-tier execution orchestrator.
  - **Conclusion**: The boundary between Billing and Models is completely clean with zero coupling.

---

## 4. Ranked Proposed Fix-Phases (Smallest First)

The following fix-phases are proposed to resolve findings from this closure review. **None have been executed. Awaiting explicit user approval before starting.**

### Fix-Phase 1: Remove Anon Client Mutation on `creditPackageRepo` in Container Wiring
- **Severity**: **HIGH** (Tenant Isolation & Authorization: runtime mutator overwrites `service_role` client with public anon client).
- **Files**: `apiOpenArt/src/container.js:151-153`
- **Action**: Delete lines 151-153 (`if (creditPackageRepo && supabase) { creditPackageRepo.supabase = supabase; }`). `creditPackageRepo` retains `_supabaseForBilling`.
- **Tests**: `npm run gate` + `tests/unit/billingRepositories.test.js`.
- **Rollback**: `git checkout src/container.js`.

### Fix-Phase 2: Regenerate Service Catalog to Clear Gate Failure
- **Severity**: **LOW** (Gate / Tooling cleanliness: removes gate FAIL at commit `6e78ca0`).
- **Files**: `apiOpenArt/docs/agents/service-catalog.md`
- **Action**: Run `npm run catalog` to sync `storageFactory.js` registration and pruned domain service dependencies.
- **Tests**: `node scripts/gen-service-catalog.cjs --check`.
- **Rollback**: `git checkout docs/agents/service-catalog.md`.

### Fix-Phase 3: Add Pure SVG/XML Security Mutation Test
- **Severity**: **MEDIUM** (Test suite robustness: closes test blindness where `<script>` in SVG payloads masked SVG check).
- **Files**: `apiOpenArt/tests/unit/storageServiceContract.test.js`
- **Action**: Add a test asserting `storage.upload(...)` with a pure SVG/XML payload (e.g. `<svg xmlns="..."><rect width="10" height="10"/></svg>`) throws `StorageValidationError` with `/SVG \/ XML/`.
- **Tests**: `node --test tests/unit/storageServiceContract.test.js`.
- **Rollback**: `git checkout tests/unit/storageServiceContract.test.js`.

### Fix-Phase 4: Add Missing Money-Flow Tests (Double Commit & Rollback After Commit)
- **Severity**: **HIGH** (Financial ledger data integrity).
- **Files**: `apiOpenArt/tests/unit/billingContract.test.js` or `tests/boundary/atomicWalletHoldRPCsBoundary.test.js`
- **Action**:
  1. Add test verifying `commitHoldIdempotent` called twice with the same `referenceId` returns `{ status: "COMPLETED" }` without double-debiting.
  2. Add test verifying `rollbackHoldIdempotent` on an already-`COMPLETED` transaction safely throws or fails closed without balance refund.
- **Tests**: `node --test tests/unit/billingContract.test.js`.
- **Rollback**: `git checkout tests/unit/billingContract.test.js`.

### Fix-Phase 5: Add Unit & Boundary Tests for `FailedOpsService`
- **Severity**: **MEDIUM** (Dead-letter queue / background worker reliability).
- **Files**: `apiOpenArt/tests/unit/failedOpsService.test.js` (new file)
- **Action**: Add unit tests for `FailedOpsService.record`, `getPendingOps`, exponential backoff calculation (`markRetryScheduled`), and `handleRetryFailedOps` worker execution.
- **Tests**: `node --test tests/unit/failedOpsService.test.js`.
- **Rollback**: Delete `tests/unit/failedOpsService.test.js`.

### Fix-Phase 6: Migrate Legacy Test Double `.supabase` Mutators on `WalletService` to IoC
- **Severity**: **MEDIUM** (Technical debt retirement).
- **Files**: `apiOpenArt/tests/boundary/atomicWalletHoldRPCsBoundary.test.js`, `tests/unit/sheetGenerationWorkflowMediaRealService.test.js`, `apiOpenArt/src/platform/billing/WalletService.js`, `src/platform/billing/repositories/CreditPackageRepository.js`
- **Action**: Refactor the 15 test sites to construct mock repositories directly via `createWalletService({ walletRepo, txRepo })`, then remove `get supabase()` and `set supabase()` from `WalletService` and `CreditPackageRepository`.
- **Tests**: Full `npm test` (1235 tests).
- **Rollback**: `git checkout src/platform/billing/ tests/boundary/`.

### Fix-Phase 7: Migrate StorageService Positional Parameter Constructor Debt
- **Severity**: **LOW** (Technical debt retirement).
- **Files**: `apiOpenArt/src/platform/storage/StorageService.js`, 19 test call sites across 10 test files.
- **Action**: Refactor 19 test sites to use `{ bucketName, provider }` or `createStorageService`; remove positional parameter fallback from `StorageService` constructor.
- **Tests**: Full `npm test`.
- **Rollback**: `git checkout src/platform/storage/ tests/`.
