# ADR-001: Strict Modular Monolith Architecture & The 8 Business Systems

## Status
Accepted

## Context
`apiOpenArt` (Labveil AI Studio Backend) historically evolved with horizontal layers (`controllers/`, `routes/`, `db/`, `domain/`), leading to god nodes (`WorkflowMediaRepository`, `supabase`, `container.js`), cyclic dependencies (`nodeExecutor` <-> `workflowRunner`, `elementService` <-> `promptBuilder`), and leaky abstractions across domains.

To achieve enterprise-grade maintainability, isolation, and safety for autonomous AI engineering, we adopted the Strict Modular Monolith standard (Shopify Packwerk style), governed by the Architecture Constitution (`01_business_systems_architecture.md`, `02_architecture_rules_and_agent_guardrails.md`).

## Decision

1. **The 8 Business Systems Partition**:
   The entire backend domain is divided into exactly 8 encapsulated systems located in `src/systems/`:
   - **System 1: Generation & Workflows** (`src/systems/generation/`, `#generation/api`, `#generation/tools`)
   - **System 2: Models Management** (`src/systems/models/`, `#models/api`, `#models/tools`)
   - **System 3: Billing & Wallet** (`src/systems/billing/`, `#billing/api`, `#billing/tools`)
   - **System 4: Media & Storage** (`src/systems/media/`, `#media/api`, `#media/tools`)
   - **System 5: Identity & Auth** (`src/systems/identity/`, `#identity/api`, `#identity/tools`)
   - **System 6: Characters** (`src/systems/characters/`, `#characters/api`, `#characters/tools`)
   - **System 7: Elements** (`src/systems/elements/`, `#elements/api`, `#elements/tools`)
   - **System 8: Workspace** (`src/systems/workspace/`, `#workspace/api`, `#workspace/tools`)

2. **The Two-Gateway Principle (Rules 1, 8, 10, 13)**:
   Each system communicates exclusively through two public gateways:
   - `public/api.js`: Mounts Express routers for incoming HTTP requests (Rule 13: web framework isolated strictly to `public/api.js`).
   - `public/tools.js`: Exposes language-level async functions accepting and returning plain DTOs (Rule 8: plain objects only, no ORM/client leakage).
   - Direct access to any system's `internal/` directory from outside is strictly forbidden and mechanically rejected by `scripts/arch-check.cjs` (Rule 10).

3. **Shared Technical Kernel (`src/shared/`, `#shared`)**:
   Provides pure technical primitives (base `AppError`, structured Pino logger, pure Redis connection kernel) without any business domain logic.

4. **Dedicated Database Container (`src/db/dbInstance.js`)**:
   Repositories are decoupled from the global IoC composition root (`src/container.js`), eliminating circular dependencies across compilation modules (Rule 14: 0 cycles).

5. **Mechanical Ratchet Enforcement (Rules R1-R15)**:
   Architecture rules are strictly enforced by CI quality gates (`npm run arch` and `npm run gate`) with non-increasing ratchets in `arch-baseline.json`.

## Consequences
- **Positive**:
  - Zero circular dependencies across the entire codebase.
  - Complete encapsulation of domain rules, databases, and third-party SDKs.
  - 100% route and behavioral parity preserved across refactoring (86 routes, 1,463 passing tests).
  - Clear service ownership (`@owns`) on 100% of services.
- **Negative / Trade-offs**:
  - Legacy backward-compatibility facades must be maintained until complete cutover is verified across client consumers.
