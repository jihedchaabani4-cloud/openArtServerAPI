# Partie 00 Handoff — Factory Bootstrap, Guardrails & Cycle Breaking

## 1. Summary of Completed Work
All 4 atomic tickets of Partie 00 have been fully implemented, verified, and gated:

- **Ticket 0.1 (Cycle 1 broken)**:
  - Extracted `src/v2/runner/nodeBilling.js` to decouple node billing, accumulator registry, and gateways.
  - Eliminated the direct circular dependency between `nodeExecutor.js` and `workflowRunner.js`.
  - Re-exported all contracts from `workflowRunner.js` for 100% backward compatibility.
  - Test seam: `tests/unit/nodeBillingExtraction.test.js`.

- **Ticket 0.2 (Cycle 2 broken)**:
  - Made `src/domain/element/promptBuilderProService.js` pure (0 imports).
  - Exported pure helpers `extractElementTokens` and `stripElementTokens`.
  - `ElementService.buildPromptPayload` now resolves element tokens directly via `this.getElementContextForPrompt` using the injected db instance.
  - Test seam: `tests/unit/elementPromptPayloadTokens.test.js`.

- **Ticket 0.3 (Cycle 3 broken)**:
  - Created `src/models/catalogQueries.js` holding `getCatalog` and `calculateCost`.
  - `src/models/catalogPresentation.js` imports directly from `catalogQueries.js` instead of `models/index.js`.
  - `src/models/index.js` re-exports both functions, preserving the public contract.
  - Test seam: `tests/unit/modelsCatalogQueriesCycle.test.js`.

- **Ticket 0.4 (Architectural Guardrails & Cycle Detector)**:
  - Extended `scripts/arch-check.cjs` with rules R10–R15:
    - R10: System gateways restricted to `public/api.js` and `public/tools.js`.
    - R11: Forbid `internal/` importing its own system's public gateways.
    - R12: DB & SDK client isolation (`supabase`, `prisma`, `pg`, `mongoose` restricted to `internal/db/` or `internal/storage/`).
    - R13: Web frameworks (`express`, `multer`, `cookie-parser`) restricted to `public/api.js`.
    - R14: Static import cycle detector across codebase modules.
    - R15: Validate package.json `#imports` structure.
  - Added CLI flag `--seed-rule <RULE_ID>` to seed baselines safely for new rules.
  - Test seam: `tests/unit/archSystemsRules.test.js`.

## 2. Gate Verification Results
- **Full Test Suite (`npm test`)**: 1,358 passed, 0 failed (increased from 1,336 baseline).
- **Architecture Ratchet (`npm run arch`)**: OK (0 new violations across all R1-R15 rules).
- **Documentation Paths (`node scripts/check-doc-paths.cjs`)**: OK (27 references checked in 12 docs).

## 3. Pre-Conditions for Partie 01 (Shared Technical Kernel)
- The codebase is clean on branch `refactory-new-arch`.
- Circular dependencies reported in the Graph Report are eliminated.
- Guardrails are mechanically enforced by `arch-check.cjs`.
- Ready to proceed with **Partie 01: Shared Technical Kernel (`src/shared/`)**.
