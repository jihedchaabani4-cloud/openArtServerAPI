# Issue Tracker — Modular Monolith Architecture Migration

Track progress of all 12 Parties and atomic tickets.

## Phase Overview

- [x] **Partie 00: Factory Bootstrap, Guardrails & Cycle Breaking** (COMPLETED)
  - [x] **Ticket 0.1**: Break Cycle 1 (`nodeExecutor.js` <-> `workflowRunner.js`) -> `src/v2/runner/nodeBilling.js` (Completed: 1,340 tests pass)
  - [x] **Ticket 0.2**: Break Cycle 2 (`ElementService.js` <-> `promptBuilderProService.js`) -> pure prompt builder (Completed: 1,344 tests pass)
  - [x] **Ticket 0.3**: Break Cycle 3 (`catalogPresentation.js` <-> `models/index.js`) -> `catalogQueries.js` (Completed)
  - [x] **Ticket 0.4**: Tighten `scripts/arch-check.cjs` with rules R10-R15 + Cycle Detector (Completed: 1,358 tests pass)
- [ ] **Partie 01: Shared Technical Kernel (`src/shared/`)**
- [ ] **Partie 02: System 5 — Identity & Auth (`src/systems/identity/`)**
- [ ] **Partie 03: System 4 — Media & Storage (`src/systems/media/`)**
- [ ] **Partie 04: System 3 — Billing & Wallet (`src/systems/billing/`)**
- [ ] **Partie 05: System 2 — Models Management (`src/systems/models/`)**
- [ ] **Partie 06: System 6 — Characters (`src/systems/characters/`)**
- [ ] **Partie 07: System 7 — Elements (`src/systems/elements/`)**
- [ ] **Partie 08: System 8 — Workspace (`src/systems/workspace/`)**
- [ ] **Partie 09: System 1 — Generation & Workflows (`src/systems/generation/`)**
- [ ] **Partie 10: Main Router Cutover & Legacy Folder Cleanup**
- [ ] **Partie 11: Full Architecture Verification, Ratchet Zeroing & ADR Linking**
