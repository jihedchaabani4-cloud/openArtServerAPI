# AGENTS.md / CLAUDE.md — Master AI Agent Operating Rules (`apiOpenArt`)

> **READ THIS FIRST:** This file is the single authoritative entry point for any AI coding agent (Claude Code, Cursor, Gemini, Windsurf, Copilot) or engineer working in `apiOpenArt`. Do not rely on legacy mental models; strictly follow the architecture and rules defined here.

---

## 1. Repository Map (Zero-Duplication Canonical Structure)

All production source code lives exclusively in **`src/api/`**, **`src/shared/`**, **`src/systems/`**, and **`src/container.js`**.  
Creating new top-level code directories (such as `controllers/`, `routes/`, `lib/`, `src/domain/`, `src/platform/`, `src/db/`, `src/services/`, `src/models/`, or `src/v2/`) is **strictly forbidden** and blocked by `Rule R17` in `scripts/arch-check.cjs`.

```text
apiOpenArt/
├── index.js                          # Process 0: HTTP API Server bootstrap (Express + Socket.IO)
├── worker.js                         # Process 1: Generation & Billing Worker bootstrap
├── package.json                      # Subpath imports (#shared, #shared/redis, #<system>/api, #<system>/tools)
├── arch-baseline.json                # Must ALWAYS remain {} (0 violations)
├── CLAUDE.md / AGENTS.md             # This file — Master Agent Instructions
├── docs/
│   ├── architecture/
│   │   ├── SYSTEMS_ARCHITECTURE.md   # Deep guide to the 9 Business Systems & internal services
│   │   └── ARCHITECTURE_RULES.md     # Complete specification of Rules R1–R18 & protocols
│   └── agents/
│       ├── GLOSSARY.md               # Canonical domain & architectural vocabulary
│       └── service-catalog.md        # Auto-generated catalog of public tools & API routes
└── src/
    ├── container.js                  # Dependency wiring across system public gateways ONLY
    ├── api/
    │   ├── routes.js                 # Main Router mounting #<system>/api gateways
    │   └── probes/                   # Health (/health) and Readiness (/ready) probes
    ├── shared/                       # Pure technical kernel (#shared) — ZERO domain/DB/Redis eager coupling
    │   ├── config/                   # Validated envConfig & rateLimitPolicies
    │   ├── db/                       # Raw Supabase factory (#shared/db/supabase.js)
    │   ├── errors/                   # AppError, CrudServiceError, ErrorSystem, errorPolicy, sanitizeError
    │   ├── logger/                   # Pino structured logger + AsyncLocalStorage context
    │   ├── redis/                    # Lazy Redis connections (#shared/redis, lazyConnect: true)
    │   └── utils/                    # Pure helpers (pathUtils, templateUtils, mediaTypeUtils, ratioUtils, assetDto)
    └── systems/                      # The 9 Isolated Black-Box Business Systems
        ├── generation/               # System 1: Generation Intake, Queue Dispatch & BullMQ Worker
        ├── models/                   # System 2: Models Management (pure stateless provider/pricing kernel)
        ├── billing/                  # System 3: Billing & Wallet
        ├── media/                    # System 4: Media & Storage
        ├── identity/                 # System 5: Identity & Security
        ├── characters/               # System 6: Characters
        ├── elements/                 # System 7: Elements
        ├── workspace/                # System 8: Workspace (Projects, Folders, Trash)
        └── workflow-engine/          # System 9: Standalone Queue-Free Black-Box DAG Engine (Rule R18)
```

---

## 2. Standard Anatomy of Every Business System

Every Business System inside `src/systems/<system>/` follows the exact same internal folder structure:

```text
src/systems/<system>/
├── public/
│   ├── api.js            # Express Router mounted by src/api/routes.js (HTTP-facing systems ONLY)
│   └── tools.js          # Pure async DTO functions called by other systems & workers
└── internal/             # STRICTLY PRIVATE — Never imported outside src/systems/<system>/
    ├── controllers/      # Express request/response handlers wired into public/api.js
    ├── services/         # Core domain & business services + serviceAccessor.js
    ├── db/               # <system>Client.js + Repositories (Exclusive table owners)
    └── errors.js         # Single unified file for all system-specific AppError subclasses
```

*(Systems with specialized engines include dedicated internal subfolders such as `workflow-engine/internal/{core,nodes,skills,workflows}`, `generation/internal/workers`, `models/internal/{registry,execution,runtime,manifests,pricing,mapping,schema}`, `media/internal/{ingestion,storage}`, `billing/internal/workers`, or `identity/internal/middleware`.)*

---

## 3. The 10 Golden Rules for Coding Agents

1. **Never Bypass `public/tools.js` (`Rule R10`):**
   When System A needs data or actions from System B, import **exclusively** from `#<system_b>/tools`. Never import anything from `src/systems/<system_b>/internal/**`.
2. **Never Import Your Own Public Barrel (`Rule R11`):**
   Files inside `src/systems/<system>/internal/**` must use relative imports (`../services/...`, `../db/...`) and must **never** import from their own `public/api.js` or `public/tools.js`.
3. **Database & Supabase Isolation (`Rule R12`):**
   `@supabase/supabase-js` and `#shared/db/supabase.js` may **only** be imported inside `src/systems/*/internal/db/**` and `src/systems/media/internal/storage/**`. Controllers and services must call repository methods—never raw Supabase queries.
4. **Express Confinement (`Rule R13`):**
   `express` and HTTP `req`/`res` objects are confined to `src/api/`, `public/api.js`, `internal/controllers/`, and `internal/middleware/`. Never pass `req`, `res`, or raw DB clients into `public/tools.js` or `internal/services/`.
5. **Zero Circular Dependencies (`Rule R14`):**
   Both static `import`/`require` and dynamic `await import(...)` are scanned by Tarjan's SCC algorithm at both file and system levels. Circular dependencies are strictly prohibited.
6. **Closed `package.json` `#imports` & `workflow-engine` Allowlist (`Rule R15` & `Rule R18`):**
   Only `#shared`, `#shared/redis`, `#shared/db/supabase.js`, `#<system>/api`, and `#<system>/tools` are permitted in `package.json#imports`. Inside `src/systems/workflow-engine/**`, `Rule R18` enforces a strict closed allowlist (zero Redis, BullMQ, Supabase, Express, or peer-domain imports).
7. **Zero Outbound Legacy Imports & Folder Lock (`Rule R16` & `Rule R17`):**
   All code inside `src/systems/**` and `src/shared/**` is self-contained. Never create files or folders outside `src/{api,shared,systems}`.
8. **Environment Variables & Logging (`Rule R2` & `Rule R3`):**
   Never use `console.log`/`console.warn`/`console.error` (use `createLogger` from `#shared`). Never read `process.env` directly in services or controllers (use `envConfig` from `#shared`).
9. **Two-Phase Credit Hold & Media Zombie Protection:**
   Generation intake (`GenerationRequestService` / `CharacterGenerationService`) creates pending media via `#media/tools`, dispatches via `WorkflowDispatchService`, and compensates immediately if dispatch fails; `useCaseWorker` executes via `#workflow-engine/tools` with `createGenerationFailureHandler` marking only `serverContext.mediaIds` `failed` on execution failure or crash.
10. **Zero Ratchet Tolerance (`arch-baseline.json` = `{}`):**
    `arch-baseline.json` and `arch-exceptions.json` must remain completely empty (`0` violations). Never add exceptions to silence a rule violation.

---

## 4. Test Architecture (Boundary TDD — `tests/`)

Tests mirror `src/` 1:1. Never create flat micro-ticket test files or `fs.readFileSync` source-inspection tests:
- `tests/architecture/` — Tests for `scripts/arch-check.cjs` (`archRules.test.js`) and DI/route table audits (`containerAndRoutesAudit.test.js`).
- `tests/shared/` — Tests for `#shared` and `#shared/redis` (`sharedKernel.test.js`).
- `tests/systems/{generation,workflow-engine,models,billing,media,identity,characters,elements,workspace}/` — Consolidated behavioral & boundary tests importing from `#<system>/tools` and `#<system>/api`.
- `tests/helpers/` — Shared test doubles (`inMemoryWalletService.js`).

---

## 5. Mandatory Verification Commands (Run Before Finishing Any Task)

Every agent must run and pass the full quality gate before committing or completing a task:

```bash
npm run arch              # Runs scripts/arch-check.cjs (Rules R1–R18 + Cycle Detector)
npm run catalog           # Regenerates and verifies docs/agents/service-catalog.md
node scripts/check-doc-paths.cjs  # Verifies all file paths referenced in markdown docs
npm test                  # Runs the full hermetic test suite
npm run gate              # Runs all of the above + secrets scan in one command
```

---

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues (`jihedchaabani4-cloud/openArtServerAPI`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role triage label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`docs/agents/GLOSSARY.md` + `docs/adr/`). See `docs/agents/domain.md`.
