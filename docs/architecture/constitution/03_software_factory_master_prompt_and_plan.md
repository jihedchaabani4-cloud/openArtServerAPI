# AI Software Factory — Master Prompt & 12-Part Execution Plan (For Lightweight / Flash Agents)

> **Purpose:** Copy-pasteable Master System Prompt and Step-by-Step Software Factory Blueprint designed specifically so smaller/faster coding models (e.g., Flash 3.8) can refactor and build the `apiOpenArt` Modular Monolith with **zero hallucinations, zero context overflow, and 100% boundary compliance**.  
> **Frameworks Integrated:**
> - **Architecture & Rules:** `01_business_systems_architecture.md` + `02_architecture_rules_and_agent_guardrails.md`
> - **Google Elephant–Goldfish Model (EGM):** [github.com/google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (`/egm-brainstorm`, `/egm-draft`, `/egm-review`, `/egm-resolve`)
> - **Matt Pocock Engineering Skills:** [github.com/mattpocock/skills](https://github.com/mattpocock/skills) (`/setup-matt-pocock-skills`, `/grill-with-docs`, `/design-an-interface`, `/to-spec`, `/to-tickets`, `/wayfinder`, `/tdd`, `/implement`, `/code-review`, `/diagnose`, `/improve-codebase-architecture`, `/handoff`)

---

## PART A: Copy-Paste Master Prompt for the Coding Agent

Copy Everything inside the block below and give it as the initial prompt to your coding agent:

```markdown
# ROLE & OPERATING MODE: STRICT SOFTWARE FACTORY ORCHESTRATOR

You are operating as a disciplined **Software Factory** executing an architectural migration and feature build on `apiOpenArt`. Because context windows degrade quickly on large repositories (531+ files), you are **strictly forbidden** from doing bulk multi-system edits in a single turn.

## 1. MANDATORY SOURCE OF TRUTH FILES (READ FIRST)
Before taking any action, read and internalize these two constitution files:
1. `01_business_systems_architecture.md` — The 8 Business Systems, their exact responsibilities, internal services, and database ownership.
2. `02_architecture_rules_and_agent_guardrails.md` — The 12 non-negotiable rules (`public/api.js`, `public/tools.js`, private `internal/`, DTO purity, Two-Phase Credit Hold, and `arch-check` enforcement).

## 2. MANDATORY SKILL PACKS & PROTOCOLS
You must combine two industry methodologies for every phase of work:
- **Google Elephant–Goldfish Model (`https://github.com/google/elephant-goldfish-model`):**
  - **Elephant Agent (Context Holder):** Maintains `CONTEXT.md`, `GLOSSARY.md`, and `docs/designs/<phase>-spec.md`. Never writes production code directly without an approved spec.
  - **Goldfish Agents (Zero-Context Critics):** Stateless reviewers that read ONLY the phase spec and target files (without conversation history) to run 3 mandatory checks via `/egm-review`:
    1. *Comprehension Check:* Can a stateless agent explain the exact inputs, outputs, and file changes back without guessing?
    2. *Antagonistic Architecture Critique:* Does any proposed change violate `02_architecture_rules_and_agent_guardrails.md` (e.g., leaking `internal/`, raw `supabase` imports, or circular imports)?
    3. *Implementation Readiness Gate (Go/No-Go):* Are every file path, function signature, and test seam 100% explicit?
- **Matt Pocock Engineering Skills (`https://github.com/mattpocock/skills`):**
  - Use `/setup-matt-pocock-skills` and `/wayfinder` to maintain local markdown tracking under `docs/agents/`.
  - Use `/grill-with-docs` and `/design-an-interface` to lock down `public/tools.js` and `public/api.js` signatures before touching `internal/`.
  - Use `/to-spec` and `/to-tickets` to slice every phase into **atomic tickets touching at most 3 to 5 files**.
  - Use `/tdd` and `/implement` to write boundary tests against `public/tools.js` first, then implement `internal/`.
  - Use `/code-review`, `/diagnose` (if tests fail), and `/handoff` at the end of every ticket so the next agent session starts with a clean context window.

## 3. THE 4-STAGE FACTORY PIPELINE (RUN FOR EVERY SINGLE PARTIE)
Never skip a stage. Execute every Partie using these 4 sequential sub-agent roles:
1. **[STAGE 1 — PLAN (Elephant + Matt Pocock `/to-spec` & `/to-tickets`)]:**
   Read the target files for the current Partie only. Draft `docs/designs/partie-XX-spec.md` and break it into atomic tickets (`docs/agents/tickets/partie-XX-ticket-YY.md`) with explicit file paths, exact `public/tools.js` and `public/api.js` function signatures, and blocking edges.
2. **[STAGE 2 — SPEC REVIEW (Goldfish `/egm-review` + `/egm-resolve`)]:**
   Spawn a fresh-context Goldfish review against `docs/designs/partie-XX-spec.md` and `02_architecture_rules_and_agent_guardrails.md`. Fix any ambiguity or boundary violation before writing code.
3. **[STAGE 3 — BUILD (Worker Agent `/tdd` + `/implement`)]:**
   Execute ONE atomic ticket at a time (max 3–5 files). Write contract tests against `public/tools.js` / `public/api.js` first (`/tdd`), then move/write the `internal/` code. If a test fails, invoke `/diagnose` to reproduce and fix the root cause rather than guessing.
4. **[STAGE 4 — CODE REVIEW, GATE & HANDOFF (`/code-review` + `arch-check` + `/handoff`)]:**
   Run `npm run arch`, `npm run check:integrity`, and unit/boundary tests. Run `/code-review` with a fresh sub-agent to verify zero `internal/` leaks, zero circular imports, and zero `supabase` leaks. Write `docs/agents/handoffs/partie-XX-handoff.md` (`/handoff`) summarizing completed tickets before moving to the next Partie.
```

---

## PART B: The 12-Partie Software Factory Execution Plan (A to Z)

Each **Partie** below is scoped so a lightweight model can execute it cleanly without exceeding its context window.

---

### Partie 0: Factory Bootstrap, Guardrails & Cycle Breaking
- **Goal:** Set up tracking folders, break the 3 existing circular dependencies reported in the Graph Report, and lock `package.json` `#imports` + `scripts/arch-check.cjs`.
- **Plan Agent (`/setup-matt-pocock-skills`, `/wayfinder`, `/to-tickets`):**
  - Initialize `CONTEXT.md`, `GLOSSARY.md`, `docs/agents/issue-tracker.md`, and `docs/designs/partie-00-bootstrap.md`.
  - Create 4 atomic tickets:
    - **Ticket 0.1:** Break Cycle 1 (`src/v2/runner/nodeExecutor.js` <-> `src/v2/runner/workflowRunner.js`) by extracting shared runner contracts/callbacks.
    - **Ticket 0.2:** Break Cycle 2 (`src/domain/element/ElementService.js` <-> `src/domain/element/promptBuilderProService.js`) by removing `ElementService` import from `promptBuilderProService.js` and passing element data as plain DTO parameters.
    - **Ticket 0.3:** Break Cycle 3 (`src/models/catalogPresentation.js` <-> `src/models/index.js`) by importing directly from internal sibling modules instead of the barrel `index.js`.
    - **Ticket 0.4:** Update `package.json` `#imports` and `scripts/arch-check.cjs` to enforce the `src/systems/<name>/public/{api,tools}.js` and `internal/` boundary rules.
- **Goldfish Review (`/egm-review`):** Verify that breaking the 3 cycles changes zero external API behavior.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 0.1 -> 0.4 sequentially.
- **Review & Gate (`/code-review`, `/handoff`):** Run `npm run arch` and verify 0 import cycles remain.

---

### Partie 1: Shared Technical Kernel (`src/shared/`)
- **Goal:** Isolate pure technical utilities (`logger`, `asyncLocalStorage` correlation tracing, base `AppError` hierarchy, env config, Redis connections) so they contain zero domain or database logic.
- **Plan Agent (`/grill-with-docs`, `/to-spec`, `/to-tickets`):**
  - Audit `createLogger()`, `CrudServiceError`, `ErrorSystem`, `redisConnection`, and `workerRedisConnection`.
  - Draft `docs/designs/partie-01-shared-kernel.md`.
- **Goldfish Review (`/egm-review`):** Ensure `src/shared/` has zero imports from `src/systems/`, `supabase`, or domain services.
- **Build Agent (`/tdd`, `/implement`):** Consolidate shared utilities under `src/shared/` and verify all existing logger/error tests pass.
- **Review & Gate (`/code-review`, `/handoff`):** Run test suite and write `partie-01-handoff.md`.

---

### Partie 2: System 5 — Identity & Auth (`src/systems/identity/`)
- **Goal:** Build the first foundation black-box system (`identity`) owning Google OAuth, cookies, user profiles, and `assertOwns()`.
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Design `src/systems/identity/public/api.js` (`/api/auth/*`) and `src/systems/identity/public/tools.js` (`verifySession`, `getUserProfile`, `assertOwns`).
  - Move `ProfileRepository`, `authLogger`, `clearAuthCookies`, `ensureUserAccount`, and `googleCallback` into `src/systems/identity/internal/`.
- **Goldfish Review (`/egm-review`):** Check that `ProfileRepository` is the only file in `identity` importing `supabase`.
- **Build Agent (`/tdd`, `/implement`):** Write boundary contract tests for `#identity/tools`, implement `internal/`, and wire `#identity/api`.
- **Review & Gate (`/code-review`, `/handoff`):** Run auth unit tests + `arch-check` and write `partie-02-handoff.md`.

---

### Partie 3: System 4 — Media & Storage (`src/systems/media/`)
- **Goal:** Eliminate the #1 God Node in the Graph Report (`WorkflowMediaRepository` with 52 edges) by encapsulating all media, save types, upload inspection (`sharp`), cloud storage (`R2/S3/Supabase`), and workflow media linking inside `src/systems/media/`.
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Ticket 3.1: Create `internal/saveTypes.js` (`SaveTypeRegistry` defining rules, MIME types, and size limits for `character_sheet`, `character_detail`, `element_reference`, `workflow_output`, etc.).
  - Ticket 3.2: Move `MediaInspector`, `MediaUploadService`, `AssetUploadService`, and `SupabaseStorageProvider` into `src/systems/media/internal/`.
  - Ticket 3.3: Move `MediaRepository` and `WorkflowMediaRepository` into `src/systems/media/internal/db/`.
  - Ticket 3.4: Expose clean DTO functions in `src/systems/media/public/tools.js` (`createPendingMedia`, `persistExternalMedia`, `markMediaFailed`, `linkMediaToEntity`, `getMediaUrls`, `deleteMedia`) and upload routes in `public/api.js`.
- **Goldfish Review (`/egm-review`):** Verify that NO external system needs to import `WorkflowMediaRepository` or `MediaRepository` anymore.
- **Build Agent (`/tdd`, `/implement`):** Implement Tickets 3.1 -> 3.4 with boundary tests (`attachReferenceMediaFailClosedBoundary.test.js`, `Unit Media Service Contract`).
- **Review & Gate (`/code-review`, `/handoff`):** Verify all media boundary tests pass and write `partie-03-handoff.md`.

---

### Partie 4: System 3 — Billing & Wallet (`src/systems/billing/`)
- **Goal:** Isolate the wallet ledger, credit packages, two-phase credit reservation (`reserve`, `capture`, `release`), stale hold reaper (`handleExpireStaleHolds`), and `FailedOpsService` into `src/systems/billing/`.
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Ticket 4.1: Move `WalletService`, `CreditPackageRepository`, `UsageEventRepository`, and `FailedOpsRepository` into `src/systems/billing/internal/`.
  - Ticket 4.2: Move `ReservationReaper` (`handleExpireStaleHolds`) and `FailedOpsService` (`handleRetryFailedOps`) into `src/systems/billing/internal/services/`.
  - Ticket 4.3: Expose `src/systems/billing/public/tools.js` (`getBalance`, `reserveCredits`, `captureHold`, `releaseHold`) and `public/api.js` (`/api/wallet/*`, `/api/admin/wallet/*`).
- **Goldfish Review (`/egm-review`):** Ensure model catalog pricing logic (`getCatalogPricing`) is NOT inside `billing` (it belongs to `models`), keeping `billing` strictly focused on credit ledger & holds.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 4.1 -> 4.3 with full unit tests for two-phase holds, idempotency, and failed-ops retry.
- **Review & Gate (`/code-review`, `/handoff`):** Run billing test suite + `arch-check` and write `partie-04-handoff.md`.

---

### Partie 5: System 2 — Models Management (`src/systems/models/`)
- **Goal:** Create a standalone, extensible **Models Management** Business System owning the AI model registry, input validation schemas, model pricing calculation, and external AI provider adapters (`WaveSpeed`, `Google GenAI`, `LLMService`).
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Ticket 5.1: Move model schemas, `catalogPresentation`, `modelsPricing` (`getCatalogPricing`, `safeCalculateCost`), and input rule evaluators (`validateCanonicalInput`) into `src/systems/models/internal/`.
  - Ticket 5.2: Move `WaveSpeedImageResolver`, `providerResolvers`, `executeProvider`, `LLMService`, and `credentialCache` into `src/systems/models/internal/providers/`.
  - Ticket 5.3: Expose `src/systems/models/public/tools.js` (`getModelConfig`, `validateModelInputs`, `calculateOperationCost`, `executeGeneration`, `executeLLM`) and `public/api.js` (`GET /api/models`, admin model reload/pricing endpoints).
- **Goldfish Review (`/egm-review`):** Verify that adding a future AI model or provider requires only adding a file inside `src/systems/models/internal/` without touching any other system.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 5.1 -> 5.3 with unit tests for WaveSpeed routing, pricing calculation, and output contract validation.
- **Review & Gate (`/code-review`, `/handoff`):** Run models test suite + `arch-check` and write `partie-05-handoff.md`.

---

### Partie 6: System 6 — Characters (`src/systems/characters/`)
- **Goal:** Refactor `Character Domain & Controller` (currently 0.05 cohesion) into a clean, high-cohesion Business System that manages Character CRUD, traits, and reference media via `#media/tools`, while removing direct AI generation logic (`CharacterGenerationService`).
- **Plan Agent (`/grill-with-docs`, `/to-spec`, `/to-tickets`):**
  - Ticket 6.1: Move `CharacterService`, `CharacterMediaService` (refactored to call `#media/tools` instead of `WorkflowMediaRepository`), and `characterRepository` into `src/systems/characters/internal/`.
  - Ticket 6.2: Expose `src/systems/characters/public/tools.js` (`getCharacterPromptContext`, `validateCharacterExists`, `attachCharacterSheetResult`) and `public/api.js` (`/api/characters/*`).
  - Ticket 6.3: Deprecate and remove direct generation calls from `CharacterGenerationService`, routing character sheet generation to `generation` (`characterSheetUseCase`).
- **Goldfish Review (`/egm-review`):** Confirm zero direct imports of `WorkflowMediaRepository`, `supabase` (outside `internal/db/`), or `billing` inside `characters`.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 6.1 -> 6.3.
- **Review & Gate (`/code-review`, `/handoff`):** Verify character tests pass and write `partie-06-handoff.md`.

---

### Partie 7: System 7 — Elements (`src/systems/elements/`)
- **Goal:** Isolate `Elements` into `src/systems/elements/` owning element CRUD, guidelines, and trait extraction, using `#media/tools` for element images.
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Ticket 7.1: Move `ElementService`, `ElementMediaService` (calling `#media/tools`), `ElementRepository`, and `extractTraits` into `src/systems/elements/internal/`.
  - Ticket 7.2: Expose `src/systems/elements/public/tools.js` (`getElementPromptContext`, `validateElementsExist`) and `public/api.js` (`/api/elements/*`).
- **Goldfish Review (`/egm-review`):** Confirm the old cycle with `promptBuilderProService` is permanently gone and `ElementMediaService` no longer touches `WorkflowMediaRepository` directly.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 7.1 -> 7.2 and run all element unit/contract tests (`elementPartialUpdateContract.test.js`, `elementCanonicalCoverAndSourceImagesElimination.test.js`).
- **Review & Gate (`/code-review`, `/handoff`):** Run tests + `arch-check` and write `partie-07-handoff.md`.

---

### Partie 8: System 8 — Workspace (`src/systems/workspace/`)
- **Goal:** Unify `Projects`, `Folders` (`Domain Folder Tree`), and `Trash` (`TrashService`) into a cohesive `src/systems/workspace/` system.
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Ticket 8.1: Move `ProjectRepository`, `FolderRepository`, `TrashRepository`, `FolderService`, `TrashService`, and `projectReadService` into `src/systems/workspace/internal/`.
  - Ticket 8.2: Expose `src/systems/workspace/public/tools.js` (`assertProjectAccess`, `moveItemToTrash`) and `public/api.js` (`/api/projects/*`, `/api/folders/*`, `/api/trash/*`).
- **Goldfish Review (`/egm-review`):** Check that `TrashService` uses `#media/tools` when cleaning up media references rather than querying media tables directly.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 8.1 -> 8.2.
- **Review & Gate (`/code-review`, `/handoff`):** Run project, folder, and trash unit tests and write `partie-08-handoff.md`.

---

### Partie 9: System 1 — Generation & Workflows (`src/systems/generation/`)
- **Goal:** Consolidate `UseCaseService`, `JobQueueService`, `UseCaseWorker`, `V2 Composable DAG Workflow Engine` (`workflowRunner`, `nodeExecutor`, `compileWorkflow`), and `PromptIntelligenceService` (`PromptBuilderProService`, skills) into `src/systems/generation/`.
- **Plan Agent (`/design-an-interface`, `/to-spec`, `/to-tickets`):**
  - Ticket 9.1: Move `PromptBuilderProService` and prompt skills (`applyCameraStyle`, `applyCharacterTemplate`, `enhancePrompt`, `moderationSafety`, etc.) into `src/systems/generation/internal/prompt/`.
  - Ticket 9.2: Move V2 DAG compiler and runner (`compileWorkflow`, `workflowRunner`, `nodeExecutor`, `RunRepository`) into `src/systems/generation/internal/runner/`, wiring `workflowBillingGateway` to `#billing/tools`, `workflowStorageGateway` to `#media/tools`, and model execution nodes to `#models/tools`.
  - Ticket 9.3: Move `UseCaseService`, `registerAllUseCases` (`imageGenerationUseCase`, `videoGenerationUseCase`, `characterSheetUseCase`), `JobQueueService`, and `UseCaseWorker` into `src/systems/generation/internal/`, enforcing the 5-step Pre-Queue Launch Protocol (Auth/Idempotency -> Context & Cost -> Credit Hold -> Pending Media -> Protected Queue Dispatch with rollback).
  - Ticket 9.4: Expose `src/systems/generation/public/api.js` for all generation and run-status endpoints.
- **Goldfish Review (`/egm-review`):** Perform an Antagonistic Review on the failure/rollback paths: what happens if Redis queue dispatch fails after `billingTools.reserveCredits`? Verify the `try/catch` immediately calls `billingTools.releaseHold`.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 9.1 -> 9.4 with full integration tests.
- **Review & Gate (`/code-review`, `/handoff`):** Run all workflow and use-case tests and write `partie-09-handoff.md`.

---

### Partie 10: Main Router Cutover & Legacy Folder Cleanup
- **Goal:** Wire `src/app.js` exclusively to the `public/api.js` gateways of the 8 Business Systems and delete empty legacy horizontal folders (`src/controllers/`, `src/routes/`, `src/db/`, `src/domain/`).
- **Plan Agent (`/to-spec`, `/to-tickets`):**
  - Ticket 10.1: Update `src/app.js` to mount `#generation/api`, `#models/api`, `#billing/api`, `#media/api`, `#identity/api`, `#characters/api`, `#elements/api`, and `#workspace/api`.
  - Ticket 10.2: Remove obsolete re-exports and empty legacy directories.
- **Goldfish Review (`/egm-review`):** Verify via `scripts/dump-routes.cjs` that 100% of HTTP routes, methods, and middleware chains match the pre-refactor route dump byte-for-byte.
- **Build Agent (`/tdd`, `/implement`):** Execute Tickets 10.1 -> 10.2.
- **Review & Gate (`/code-review`, `/handoff`):** Run route dump comparison + full test suite.

---

### Partie 11: Full Architecture Verification, Ratchet Zeroing & ADR Linking
- **Goal:** Lock the architecture permanently so future agents can never degrade it.
- **Plan Agent (`/improve-codebase-architecture`, `/to-tickets`):**
  - Ticket 11.1: Zero out `scripts/arch-exceptions` and tighten `scripts/ratchet.cjs` and `scripts/arch-check.cjs` so any `internal/` import or `supabase` leak fails CI immediately.
  - Ticket 11.2: Link the 35 isolated ADRs (`ADR-0006` through `ADR-0012`) to the `public/api.js` and `public/tools.js` headers of their owning Business Systems and run `scripts/check-doc-paths.cjs`.
- **Goldfish Review (`/egm-review`):** Final audit across all 8 Business Systems against `01_business_systems_architecture.md` and `02_architecture_rules_and_agent_guardrails.md`.
- **Build Agent (`/implement`):** Execute Tickets 11.1 -> 11.2.
- **Review & Gate (`/code-review`, `/handoff`):** Run `npm run arch`, `npm run check:integrity`, and full test suite, then generate the final architecture completion report.
