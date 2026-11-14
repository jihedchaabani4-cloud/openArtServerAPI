# Handoff Report — Partie 03: System 4 — Media & Storage (`src/systems/media/`)

> **Application**: `apiOpenArt` (Labveil AI Studio Backend)  
> **Branch**: `refactory-new-arch`  
> **Status**: COMPLETED & VERIFIED  
> **Date**: 2026-11-13  
> **Quality Gate Status**: PASS (1,393 tests passing, 0 failures, 0 arch-check violations)

---

## 1. Objectives Completed

In this phase, we encapsulated the critical God Node (`WorkflowMediaRepository` with 52 coupling edges) and constructed **System 4: Media & Storage** (`src/systems/media/`), strictly enforcing the architecture constitution (`01_business_systems_architecture.md`, `02_architecture_rules_and_agent_guardrails.md`).

1. **Ticket 3.1: Save-Type Registry & Storage Provider Abstraction (`internal/saveTypes.js`, `internal/storage/`)**
   - Declarative `SaveTypeRegistry` supporting standard save types (`upload`, `generated`, `intermediate`, `thumbnail`, `character_sheet`, `element_reference`, `default`) with MIME inspection, size limits, and retention policies.
   - Provider-agnostic `IStorageProvider` contract implemented by `SupabaseStorageProvider` and test-isolated `InMemoryStorageProvider`.
   - `StorageService` facade with canonical path resolution (`StoragePathResolver`), stream hashing, and typed error hierarchy (`StorageError`, `StorageValidationError`).
   - Clean factory `createStorageService({ client, bucketName })` for injection.

2. **Ticket 3.2: Media DB Layer (`internal/db/`)**
   - Exclusive database table ownership of `public.media` and `public.workflow_media`.
   - Isolated Supabase database client instantiation (`mediaClient.js`) strictly inside `internal/db/` (Rule 6, Rule 12).
   - Encapsulated `MediaRepository` and `WorkflowMediaRepository`.
   - Domain operations extracted to pure internal modules: `workflowMediaOps.js`, `workflowMediaLinker.js`, `workflowMediaRole.js`.

3. **Ticket 3.3: Ingestion, Inspection & Lifecycle Services (`internal/ingestion/`, `internal/services/`)**
   - MIME and format sniffing using `sharp` and magic byte verification in `MediaInspector`.
   - Security scanning to reject SVG/XML script injection and MZ executable files.
   - Policy-driven ingestion services: `SourceResolver`, `SourceReader`, `SourcePolicy`, `MediaUploadService`, and `AssetUploadService`.
   - Business services: `MediaService`, `MediaLifecycleService`, `mediaMetadataResolver.js` with `@owns System 4: Media & Storage`.

4. **Ticket 3.4: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`)**
   - Created `src/systems/media/public/api.js` (`#media/api`) isolating Express and Multer (Rule 13) for asset uploads (`POST /assets/upload`, `POST /media/ingest`).
   - Created `src/systems/media/public/tools.js` (`#media/tools`) exposing clean async DTO operations:
     - `createPendingMedia`, `persistExternalMedia`, `markMediaFailed`, `linkMediaToEntity`, `getMediaUrls`, `getMediaById`, `deleteMedia`.
     - Singleton getters: `getMediaRepository`, `getWorkflowMediaRepository`, `getStorageService`, `getMediaUploadService`, `getMediaService`, `getSaveTypeRegistry`.
   - Registered `#media/api` and `#media/tools` in `package.json#imports` (Rule 15).
   - Maintained 100% backward compatibility via legacy re-exports in:
     - `routes/assets.js`
     - `routes/mediaIngestRoutes.js`
     - `src/platform/storage/index.js`
     - `src/platform/storage/StorageErrors.js`
     - `src/platform/media-ingestion/index.js`
     - `src/platform/media/index.js`
     - `src/db/MediaRepository.js`
     - `src/db/WorkflowMediaRepository.js`
   - Added comprehensive hermetic unit test suite: `tests/unit/mediaSystem.test.js` (14 passing tests).

---

## 2. Key Architecture Discoveries & Decisions

1. **Cycle Elimination**:
   - `MediaWorkflowLifecycleService` formerly held a direct static import of `V1StorageBridge.js` from V2 runner, creating an import loop back into `#media/tools`. Converted to dynamic lazy import when `db` is injected without an explicit bridge.
   - Removed `AssetUploadService` from `#media/tools` root surface (leaving it internally scoped) to maintain strict layer separation from workflow engine.
   - Result: Rule R14 circular dependency count remains at **0**.
2. **Environment Dynamic Getters**:
   - Enhanced `src/shared/config/env.js` with dynamic getters for `isProduction` and `isTest`, ensuring test harnesses temporarily overriding `process.env.NODE_ENV` behave as expected without direct `process.env` access in domain repositories (Rule R3).
3. **Prototype Parity**:
   - Re-exported canonical `StorageError` and `StorageValidationError` from `#media/tools` across all legacy entry points to preserve exact `instanceof` check compatibility across all existing platform and workflow test suites.

---

## 3. Verification & Quality Gates

| Gate Check | Command | Result |
| :--- | :--- | :--- |
| **Hermetic Test Suite** | `npm test` | **PASS**: 1,393 tests passing, 0 failures, 0 skipped |
| **Architecture Ratchet** | `npm run arch` | **PASS**: 0 new violations across R1-R15 |
| **Cycle Detector** | `node scripts/arch-check.cjs` | **PASS**: 0 static import cycles (R14 clean) |
| **Package Imports** | `node scripts/arch-check.cjs` | **PASS**: 0 alias violations (R15 clean) |
| **Doc References** | `node scripts/check-doc-paths.cjs` | **PASS**: 27 references valid |
| **Service Catalog** | `npm run catalog` | **PASS**: Catalog regenerated |
| **Full Gate** | `npm run gate` | **PASS** |

---

## 4. Next Phase: Partie 04 — System 3: Billing & Wallet (`src/systems/billing/`)

- **Scope**: Encapsulate user credit wallets, multi-currency ledger transactions, credit reservation/hold lifecycle, and pricing catalog into `src/systems/billing/`.
- **Public Gateways**: `src/systems/billing/public/api.js` (`#billing/api`) and `src/systems/billing/public/tools.js` (`#billing/tools`).
- **Internal Modules**: `WalletService`, `PricingService`, `FailedOpsService`, `WalletRepository`, `LedgerRepository`.
- **Key Enforcements**: Two-Phase Credit Hold pattern (Rule 10), atomic SQL balance deduction, and idempotent hold release.
