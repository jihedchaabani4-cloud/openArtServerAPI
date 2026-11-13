# Issue Tracker — Modular Monolith Architecture Migration

Track progress of all 12 Parties and atomic tickets.

## Phase Overview

- [x] **Partie 00: Factory Bootstrap, Guardrails & Cycle Breaking** (COMPLETED)
  - [x] **Ticket 0.1**: Break Cycle 1 (`nodeExecutor.js` <-> `workflowRunner.js`) -> `src/v2/runner/nodeBilling.js` (Completed: 1,340 tests pass)
  - [x] **Ticket 0.2**: Break Cycle 2 (`ElementService.js` <-> `promptBuilderProService.js`) -> pure prompt builder (Completed: 1,344 tests pass)
  - [x] **Ticket 0.3**: Break Cycle 3 (`catalogPresentation.js` <-> `models/index.js`) -> `catalogQueries.js` (Completed)
  - [x] **Ticket 0.4**: Tighten `scripts/arch-check.cjs` with rules R10-R15 + Cycle Detector (Completed: 1,358 tests pass)
- [x] **Partie 01: Shared Technical Kernel (`src/shared/`)** (COMPLETED)
  - [x] **Ticket 1.1**: Base Error Hierarchy & Runtime Error Processor (`src/shared/errors/`) [DONE]
  - [x] **Ticket 1.2**: Structured Logging & Tracing Infrastructure (`src/shared/logger/`) [DONE]
  - [x] **Ticket 1.3**: Pure Technical Config & Redis Connection Kernel (`src/shared/config/`, `src/shared/redis/`, `#shared`) [DONE]
- [x] **Partie 02: System 5 — Identity & Auth (`src/systems/identity/`)** (COMPLETED)
  - [x] **Ticket 2.1**: Identity Errors & Internal DB Layer (`internal/db/`, `internal/errors.js`) [DONE]
  - [x] **Ticket 2.2**: Internal Services & Cookie Management (`internal/services/`, `internal/cookies.js`) [DONE]
  - [x] **Ticket 2.3**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`) [DONE]
- [x] **Partie 03: System 4 — Media & Storage (`src/systems/media/`)** (COMPLETED)
  - [x] **Ticket 3.1**: Save-Type Registry & Storage Provider Abstraction (`internal/saveTypes.js`, `internal/storage/`) [DONE]
  - [x] **Ticket 3.2**: Media DB Layer (`internal/db/`) [DONE]
  - [x] **Ticket 3.3**: Ingestion, Inspection & Lifecycle Services (`internal/ingestion/`, `internal/services/`) [DONE]
  - [x] **Ticket 3.4**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`) [DONE]
- [x] **Partie 04: System 3 — Billing & Wallet (`src/systems/billing/`)** (COMPLETED)
  - [x] **Ticket 4.1**: Billing Errors & Internal DB Layer (`internal/db/`, `internal/errors.js`) [DONE]
  - [x] **Ticket 4.2**: Two-Phase Credit Hold & Pricing Services (`internal/services/`) [DONE]
  - [x] **Ticket 4.3**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`) [DONE]
- [x] **Partie 05: System 2 — Models Management (`src/systems/models/`)** (COMPLETED)
  - [x] **Ticket 5.1**: Model Schemas, Registry & Pricing Calculation (`internal/registry/`, `internal/pricing/`, `internal/errors.js`) [DONE]
  - [x] **Ticket 5.2**: AI Provider Resolvers & Execution Adapters (`internal/providers/`, `internal/execution/`) [DONE]
  - [x] **Ticket 5.3**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`) [DONE]
- [x] **Partie 06: System 6 — Characters (`src/systems/characters/`)** (COMPLETED)
  - [x] **Ticket 6.1**: Character Service, Media Service & Repositories (`internal/services/`, `internal/db/`, `internal/errors.js`) [DONE]
  - [x] **Ticket 6.2**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`) [DONE]
  - [x] **Ticket 6.3**: Deprecate Direct Generation Calls & Reroute to System 1 Generation (`characterSheetUseCase`) [DONE]
- [ ] **Partie 07: System 7 — Elements (`src/systems/elements/`)** (READY)
  - [ ] **Ticket 7.1**: Element Service, Media Service, Repositories & Trait Extraction (`internal/services/`, `internal/db/`, `internal/errors.js`)
  - [ ] **Ticket 7.2**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`)
- [ ] **Partie 08: System 8 — Workspace (`src/systems/workspace/`)**
- [ ] **Partie 09: System 1 — Generation & Workflows (`src/systems/generation/`)**
- [ ] **Partie 10: Main Router Cutover & Legacy Folder Cleanup**
- [ ] **Partie 11: Full Architecture Verification, Ratchet Zeroing & ADR Linking**
