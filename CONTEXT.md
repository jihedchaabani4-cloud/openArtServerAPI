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
- [x] **Partie 09: System 1 — Generation & Workflows (`src/systems/generation/`)** (1,461 tests pass, `#generation/api`, `#generation/tools`)
- [x] **Partie 10: Main Router Cutover & Legacy Folder Cleanup** (1,463 tests pass, 8 systems gateways exclusively mounted)

## 3. Active Phase: Partie 11 (READY) — Full Architecture Verification, Ratchet Zeroing & ADR Linking
- **Goal**: Permanently lock architecture rules R1-R15 in `arch-baseline.json`, verify all ADRs and seams, and conduct final end-to-end security & architecture sign-off.
- **Suite Status**: 1,463 tests passing (0 failures), Gate PASS.

## 4. Active Tickets Roadmap (Partie 11)
- [ ] **Ticket 11.1**: Ratchet zeroing in `arch-baseline.json` for all rules whose counts have reached zero
- [ ] **Ticket 11.2**: ADR documentation & linkage across the 8 systems
- [ ] **Ticket 11.3**: Final full quality gate and factory completion report
