# CONTEXT.md — apiOpenArt Architecture Context & State

## 1. Project Identity
- **Application**: `apiOpenArt` (Labveil AI Studio Backend)
- **Current Branch**: `refactory-new-arch`
- **Architecture Standard**: Strict Modular Monolith (Shopify Packwerk style) governed by:
  - `docs/architecture/constitution/01_business_systems_architecture.md` (The 8 Business Systems)
  - `docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md` (The 12 Architecture Rules)
  - `docs/architecture/constitution/03_software_factory_master_prompt_and_plan.md` (Software Factory Plan)

## 2. Active Phase: Partie 00 (COMPLETED) -> Ready for Partie 01
- **Goal**: Break 3 circular dependencies and establish mechanical architectural guardrails in `scripts/arch-check.cjs`.
- **Target Systems in Scope**:
  - `src/v2/runner/` (Workflow DAG runner & node execution)
  - `src/domain/element/` (Element reference & prompt builder)
  - `src/models/` (Catalog presentation & sealed model subsystem)
- **Baseline Test Suite Status**: 1,358 tests passing, 0 failures.

## 3. Active Tickets Roadmap
- [x] **Ticket 0.1**: Break Cycle 1 (`src/v2/runner/nodeExecutor.js` <-> `src/v2/runner/workflowRunner.js`) via `nodeBilling.js` [DONE - 1,340 tests passing]
- [x] **Ticket 0.2**: Break Cycle 2 (`src/domain/element/ElementService.js` <-> `src/domain/element/promptBuilderProService.js`) by making prompt builder pure [DONE - 1,344 tests passing]
- [x] **Ticket 0.3**: Break Cycle 3 (`src/models/catalogPresentation.js` <-> `src/models/index.js`) via `src/models/catalogQueries.js` [DONE]
- [x] **Ticket 0.4**: Implement systems guardrails R10-R15 + Cycle Detector in `scripts/arch-check.cjs` [DONE - 1,358 tests passing]
