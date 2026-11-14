# Partie 00 — Factory Bootstrap, Guardrails & Cycle Breaking (Spec)

Branch: `refactory-new-arch`
Constitution: `docs/architecture/constitution/01_business_systems_architecture.md`, `docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md`.
Baseline before Partie 0: `npm test` = 1336 pass / 0 fail.

## Goal

1. Break the 3 named import cycles with **zero external behavior change** (except Ticket 0.2's bug fix, see below).
2. Make `scripts/arch-check.cjs` enforce the constitution's `src/systems/<name>/public/{api,tools}.js` + `internal/` rules and detect import cycles.

## Measured reality (read before trusting the plan)

A static import graph of the code dirs (relative + `package.json#imports`) shows:

| Cycle | Files | Status |
| :-- | :-- | :-- |
| Cycle 3 | `src/models/catalogPresentation.js` <-> `src/models/index.js` | Isolated 2-file cycle. |
| Cycle 2 | `src/domain/element/ElementService.js` <-> `src/domain/element/promptBuilderProService.js` | Real cycle. Hidden from case-sensitive tools because `promptBuilderProService.js` imports `./elementService.js` (lowercase `e`). Works on Windows, **breaks on Linux**. |
| Cycle 1 | `src/v2/runner/nodeExecutor.js` <-> `src/v2/runner/workflowRunner.js` | Direct 2-file cycle, but **both files are also inside a 27-file strongly connected component** through `src/container.js`, `src/platform/workflow/*`, `src/v2/nodes/*`, `src/services/useCaseService.js`, etc. |

> Consequence: after Partie 0 the 3 named cycles are gone, but the repo will **not** have 0 cycles. The 27-file component is legacy debt owned by Parties 3, 6, 8, 9 (it dissolves as `container.js` wiring moves into systems). Partie 0 adds a ratcheted cycle rule so it can only shrink.

## Tickets (sequential, each ≤ 5 files)

| Ticket | Files | Blocks |
| :-- | :-- | :-- |
| `docs/agents/tickets/partie-00-ticket-01.md` | `src/v2/runner/nodeBilling.js` (new), `src/v2/runner/workflowRunner.js`, `src/v2/runner/nodeExecutor.js` | 0.4 |
| `docs/agents/tickets/partie-00-ticket-02.md` | `src/domain/element/promptBuilderProService.js`, `src/domain/element/ElementService.js`, `tests/unit/elementPromptPayloadTokens.test.js` (new) | 0.4 |
| `docs/agents/tickets/partie-00-ticket-03.md` | `src/models/catalogQueries.js` (new), `src/models/index.js`, `src/models/catalogPresentation.js` | 0.4 |
| `docs/agents/tickets/partie-00-ticket-04.md` | `scripts/arch-check.cjs`, `tests/unit/archRuleR10.test.js`, `tests/unit/archSystemsRules.test.js` (new), `arch-baseline.json` | — |

### Ticket 0.1 — Extract node billing out of `workflowRunner.js`

Direction after: `workflowRunner.js -> nodeExecutor.js -> nodeBilling.js`, and `workflowRunner.js -> nodeBilling.js`. `nodeBilling.js` imports neither runner file.

Move **verbatim** from `workflowRunner.js` into new `src/v2/runner/nodeBilling.js`:
`PROVIDER_BACKED_NODE_TYPES`, `class PersistedBillingAccumulator`, the `activeAccumulators` map, `getRunBillingAccumulator(runId)`, the gateway state + `initializeGateways({ billing, storage, events })` + `getGateways()`, `isProviderBackedNodeType(nodeType)`, `getNodeBillingReference(runId, nodeId, attempt)`, `estimateNodeBillingAmount(nodeConfig, resolvedInputs)`, `reserveNodeBilling(...)`, `settleNodeBilling(...)`, `rollbackNodeBilling(...)`.

New exports in `nodeBilling.js` (replace direct map access in `startWorkflowRun`):
- `beginRunBillingAccumulator(runId) -> PersistedBillingAccumulator` — creates and registers.
- `endRunBillingAccumulator(runId) -> void` — unregisters.

`nodeBilling.js` owns its own `createLogger("workflow")` (same logger name, so log output is unchanged) and `new RunRepository()` (memory state is module-level in `runRepository.js`, so instances share it).

`workflowRunner.js`:
- imports what it needs from `./nodeBilling.js`; reads `eventRecorder` through `getGateways()` at call time.
- re-exports every name above with `export { ... } from "./nodeBilling.js"` so `src/v2/bootstrap.js`, `src/use-cases/useCaseRunner.js`, `src/workers/useCaseWorker.js`, `controllers/v2/workflowsController.js` and 13 boundary tests keep working unchanged.

`nodeExecutor.js`: only the import source changes (`./workflowRunner.js` -> `./nodeBilling.js`).

Test seam: existing suite (`tests/boundary/distributedAccumulatorBoundary.test.js`, `tests/boundary/useCaseWorkflowAndSettlementBoundary.test.js`, `tests/boundary/orchestrationFailureBillingBoundary.test.js`, `tests/boundary/swallowedErrorLoggingBoundary.test.js`, ...). Structural guard added in 0.4.

### Ticket 0.2 — `promptBuilderProService.js` becomes pure

- Delete `import { getElementContextForPrompt } from "./elementService.js"`.
- Export pure helper `extractElementTokens(prompt: string) -> string[]` (existing function, now exported).
- New signature: `buildMultiElementPayload({ userPrompt, elements = [] })`. `projectId` removed. Each element is a plain DTO `{ name, description?, rules?, consistency_rules?, master_identity?, reference_images?, sheet_image?, reference_sheet_url?, _contextNote? }`. Return shape unchanged: `{ compiled_prompt, reference_sheets, negative_prompt, referenceImages, contextNote, scenePrompt }`.
- `ElementService.buildPromptPayload({ userPrompt, elements = [], elementIds = [], projectId })` now resolves `@tokens` itself: after the `elementIds` lookups, if `projectId` and `userPrompt` is a string, for each token call `this.getElementContextForPrompt({ nameOrId: token, projectId })` and append `{ name, description, reference_images: ctx.referenceImageUrls, _contextNote: ctx.contextNote }`; unknown tokens log `logger.warn` and are skipped. Element order is unchanged (`elements`, then `elementIds`, then tokens).
- **Intentional bug fix:** before, tokens were resolved through the module's default `ElementService` singleton (default repos), ignoring the instance's injected `db`. Now the instance's own `db` is used. Only caller: `controllers/elementController.js` -> container `elementService`; same real repositories in production.

Test seam (red first): `ElementService.buildPromptPayload` with an injected fake `db` — `@Hero` resolves to the fake element's description and media URL.

### Ticket 0.3 — models barrel cycle

- New `src/models/catalogQueries.js` holding `getCatalog(filters)` and `calculateCost(modelFamily, cleanInput, options)` moved verbatim from `src/models/index.js` (with its own `createLogger("models")`).
- `src/models/index.js` imports both from `./catalogQueries.js` and re-exports them (public API of `#models` unchanged; `tests/unit/modelsContract.test.js` stays green).
- `src/models/catalogPresentation.js` imports from `./catalogQueries.js`, never from `./index.js`.
- Keeps the already uncommitted deletion of the unused `clearModelConfigCache` (0 callers).
- Registry init: `getRegistry()` lazily calls `initRegistry()`, so `catalogQueries.js` is safe even when `index.js` is not loaded.

### Ticket 0.4 — guardrails in `scripts/arch-check.cjs`

| Rule | Scope | Fails when |
| :-- | :-- | :-- |
| R10 (tightened) | all code dirs | A file outside `src/systems/<X>/` imports anything in `src/systems/<X>/` except `public/api.js` / `public/tools.js`, or any `#<X>` alias except `#<X>/api` / `#<X>/tools`. `index.js` and bare `#<X>` are **no longer** gateways (constitution Rule 1). |
| R11 | `src/systems/<X>/internal/**` | imports its own `src/systems/<X>/public/*` or `#<X>/api` / `#<X>/tools` (Rule 7). |
| R12 | `src/systems/**` | imports a DB/storage client (`@supabase/*`, `supabase`, `pg`, `prisma`, `@prisma/*`, `mongoose`, `@aws-sdk/*`, or the legacy `lib/supabase.js`) outside `src/systems/<X>/internal/db/**` or `src/systems/media/internal/storage/**` (Rule 6). |
| R13 | `src/systems/**` | imports `express*`, `multer` or `cookie-parser` outside `src/systems/<X>/public/api.js` (Rule 3/4, checker §5.3). |
| R14 | all code dirs | file is part of a static import cycle (`import ... from`, `export ... from`, `require()`; dynamic `import()` excluded because it does not create load-order cycles). Resolves relative paths, `package.json#imports` (exact + wildcard), and case-insensitive fallback. |
| R15 | `package.json#imports` | a key targets `src/systems/**` but is not an exact (non-wildcard) mapping to `public/api.js` or `public/tools.js`. |

New CLI flag: `node scripts/arch-check.cjs --seed-rule <ID>` adds baseline keys **only** for a rule that has zero keys in `arch-baseline.json`. It never raises existing keys. Used once in this ticket for R14.

`package.json#imports`: **no new aliases in Partie 0.** A mapping to a non-existent `src/systems/*` file would make agents think the system exists. Each Partie that creates a system adds exactly `#<name>/api` and/or `#<name>/tools`; R15 enforces the shape.

Exports for tests: `checkRuleR10`, `RULES`, `findImportCycles(files, pkgImports)`, `checkPackageImports(pkgImports)`, `collect`.

Test seams (`tests/unit/archSystemsRules.test.js`): each rule's `run(file)` with in-memory files; `findImportCycles` on synthetic graphs (2-file cycle, case-mismatch cycle, dynamic import ignored); `checkPackageImports`; plus a repo regression check that none of the 3 Partie 0 pairs is in any cycle.

## Acceptance criteria (Partie gate)

- [ ] `npm test` passes, test count ≥ 1336 + new tests.
- [ ] `npm run arch` -> `arch-check: OK (no new violations)`.
- [ ] R14 report lists none of: `src/models/catalogPresentation.js`, `src/domain/element/promptBuilderProService.js`; and no direct edge `src/v2/runner/nodeExecutor.js -> src/v2/runner/workflowRunner.js`.
- [ ] No public behavior change for `#models`, `/api/elements/*`, workflow runs (except Ticket 0.2 bug fix).
- [ ] `docs/agents/handoffs/partie-00-handoff.md` written.

## Out of scope

Moving any file into `src/systems/`, deleting legacy folders, the 27-file component, `npm run check:integrity` (needs live Supabase; run manually).
