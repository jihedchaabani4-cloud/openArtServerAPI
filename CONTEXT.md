# CONTEXT.md — apiOpenArt Architecture Context & State

## 1. Project Identity
- **Application**: `apiOpenArt` (Labveil AI Studio Backend)
- **Current Branch**: `refactory-new-arch`
- **Architecture Standard**: Strict Modular Monolith (Shopify Packwerk style) governed by:
  - `docs/architecture/constitution/01_business_systems_architecture.md` (The 8 Business Systems)
  - `docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md` (The 12 Architecture Rules)
  - `docs/architecture/constitution/03_software_factory_master_prompt_and_plan.md` (Software Factory Plan)

## 2. Completed Phases
- [x] **Partie 00: Factory Bootstrap, Guardrails & Cycle Breaking** (1,358 tests pass, 0 cycles)
- [x] **Partie 01: Shared Technical Kernel (`src/shared/`)** (1,372 tests pass, `#shared`)
- [x] **Partie 02: System 5 — Identity & Auth (`src/systems/identity/`)** (1,379 tests pass, `#identity/api`, `#identity/tools`)
- [x] **Partie 03: System 4 — Media & Storage (`src/systems/media/`)** (1,393 tests pass, `#media/api`, `#media/tools`)

## 3. Active Phase: Partie 04 (READY) — System 3: Billing & Wallet (`src/systems/billing/`)
- **Goal**: Encapsulate user credit wallets, multi-currency ledger transactions, credit reservation/hold lifecycle, and pricing catalog into `src/systems/billing/`.
- **Target Boundaries**:
  - `src/systems/billing/public/api.js` (`#billing/api`) for wallet and checkout HTTP routes.
  - `src/systems/billing/public/tools.js` (`#billing/tools`) for inter-system credit hold, settlement, refund, and balance queries.
  - Subpath imports `#billing/api` and `#billing/tools` in `package.json#imports`.
  - Zero external imports of `internal/`.
- **Suite Status**: 1,393 tests passing (0 failures), Gate PASS.

## 4. Active Tickets Roadmap (Partie 04)
- [ ] **Ticket 4.1**: Billing Errors & Internal DB Layer (`internal/db/WalletRepository.js`, `LedgerRepository.js`, `internal/errors.js`)
- [ ] **Ticket 4.2**: Two-Phase Credit Hold & Pricing Services (`internal/services/WalletService.js`, `PricingService.js`, `FailedOpsService.js`)
- [ ] **Ticket 4.3**: Public Gateways, Package Subpath Imports, Legacy Re-exports & Tests (`public/`, `package.json`)
