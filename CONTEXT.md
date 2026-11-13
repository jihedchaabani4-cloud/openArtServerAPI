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
- [x] **Partie 05: System 2 — Models Management (`src/systems/models/`)** (1,418 tests pass, `#models/api`, `#models/tools`)
- [x] **Partie 06: System 6 — Characters (`src/systems/characters/`)** (1,431 tests pass, `#characters/api`, `#characters/tools`)
- [x] **Partie 07: System 7 — Elements (`src/systems/elements/`)** (1,443 tests pass, `#elements/api`, `#elements/tools`)
- [x] **Partie 08: System 8 — Workspace (`src/systems/workspace/`)** (1,454 tests pass, `#workspace/api`, `#workspace/tools`)

## 3. Active Phase: Partie 09 (READY) — System 1: Generation & Workflows (`src/systems/generation/`)
- **Goal**: Consolidate `UseCaseService`, `JobQueueService`, `UseCaseWorker`, `V2 Composable DAG Workflow Engine` (`workflowRunner`, `nodeExecutor`, `compileWorkflow`), and `PromptIntelligenceService` (`PromptBuilderProService`, skills) into `src/systems/generation/`.
- **Target Boundaries**:
  - `src/systems/generation/public/api.js` (`#generation/api`) for all generation, workflow runs, images, video, and prompt endpoints.
  - `src/systems/generation/public/tools.js` (`#generation/tools`) for inter-system operations.
  - Subpath imports `#generation/api` and `#generation/tools` in `package.json#imports`.
  - Zero external imports of `internal/`.
- **Suite Status**: 1,454 tests passing (0 failures), Gate PASS.

## 4. Active Tickets Roadmap (Partie 09)
- [ ] **Ticket 9.1**: Prompt Intelligence Service & Prompt Skills (`internal/prompt/`)
- [ ] **Ticket 9.2**: V2 DAG Compiler, Runner & Execution Gateways (`internal/runner/`)
- [ ] **Ticket 9.3**: UseCase Engine, Worker & Pre-Queue Launch Protocol (`internal/engine/`, `internal/queue/`)
- [ ] **Ticket 9.4**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`)
