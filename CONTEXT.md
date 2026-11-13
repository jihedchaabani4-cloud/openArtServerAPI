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
- [x] **Partie 04: System 3 — Billing & Wallet (`src/systems/billing/`)** (1,405 tests pass, `#billing/api`, `#billing/tools`)

## 3. Active Phase: Partie 05 (READY) — System 2: Models Management (`src/systems/models/`)
- **Goal**: Create a standalone, extensible **Models Management** Business System owning the AI model registry, input validation schemas, model pricing calculation, and external AI provider adapters (`WaveSpeed`, `Google GenAI`, `LLMService`).
- **Target Boundaries**:
  - `src/systems/models/public/api.js` (`#models/api`) for catalog presentation and admin pricing/model reload routes.
  - `src/systems/models/public/tools.js` (`#models/tools`) for inter-system operations: `getModelConfig`, `validateModelInputs`, `calculateOperationCost`, `executeGeneration`, `executeLLM`.
  - Subpath imports `#models/api` and `#models/tools` in `package.json#imports`.
  - Zero external imports of `internal/`.
- **Suite Status**: 1,405 tests passing (0 failures), Gate PASS.

## 4. Active Tickets Roadmap (Partie 05)
- [ ] **Ticket 5.1**: Model Schemas, Registry & Pricing Calculation (`internal/registry/`, `internal/pricing/`, `internal/errors.js`)
- [ ] **Ticket 5.2**: AI Provider Resolvers & Execution Adapters (`internal/providers/WaveSpeedImageResolver.js`, `LLMService.js`, `credentialResolver.js`)
- [ ] **Ticket 5.3**: Public Gateways, Package Subpath Imports, Legacy Re-exports & Tests (`public/`, `package.json`)
