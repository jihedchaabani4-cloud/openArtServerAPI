# Proposed AST Boundary Enforcement (`apiOpenArt`)

> **Status**: **PROPOSAL ONLY** — Do NOT implement or modify `apiOpenArt/scripts/*.cjs` or `apiOpenArt/arch-baseline.json` without explicit human approval (`AGENTS.md`).

---

## 1. Current Ratchet vs. Blind Spots

`apiOpenArt/scripts/arch-check.cjs` (`lines 70-170`) paired with `apiOpenArt/scripts/lib/ratchet.cjs` (`lines 25-45`) currently enforces 8 line-level regex/SQL checks (`R1`–`R4`, `R6`–`R9`) against `apiOpenArt/arch-baseline.json`:

| Enforced Today | Cannot Enforce Today (Regex Limitations) |
|---|---|
| `R1`: `routes/` & `controllers/` imports of `db`/`Repository`/`supabase`/`StorageService` | Deep imports into a System's private files vs. its single `index.js` entry (Rule 3) |
| `R2`: `console.*` calls in source | Wildcard `*` subpaths in `apiOpenArt/package.json` `"imports"` (Rule 3) |
| `R3`: `process.env` reads outside `config`/`env` | System-to-System dependency direction, Foundation tier isolation, or `#alias` cross-layer imports (`layerReport` at `arch-check.cjs:164` checks only `s.spec.startsWith('.')` and is report-only) (Rule 6) |
| `R4`: Domain tokens (`Element`/`Character`/`Workflow`) in `MediaUploadService` | Static import cycles and runtime setter cycles (`setWorkflowService`, `setEntitySyncHandlers`) (Rule 6) |
| `R6`: `SECURITY DEFINER` migrations revoking `PUBLIC, anon, authenticated` | Foreign table queries (`.from("media")`) or shared `db.<repo>` bag access across Systems (Rule 5) |
| `R7`: `!== false` in media/upload/storage/rollback files | Direct `supabase` / `createClient` usage inside `*Service.js` outside `*Repository.js` (Rule 7) |
| `R8`: Indented `require(` in `*Service.js` | Exported surface hygiene on `index.js`, bare `throw new Error(...)`, or unprefixed error classes (Rules 3, 4, 8) |
| `R9`: `@owns` header in `*Service.js` | Multi-line `import ... from\n '...'` specifiers, block-comment false positives, and controller multi-System orchestration (Rule 12) |

---

## 2. Proposed AST Architecture (Complementing `ratchet.cjs`)

1. **Single-Pass ESM AST Parse**: Parse each file in `CODE_DIRS` once into an ESTree AST (`sourceType: "module"`, `ecmaVersion: "latest"`, comment attachment enabled) and resolve every static/dynamic specifier (`ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`, `ImportExpression`, `CallExpression[callee.name="require"]`) through `apiOpenArt/package.json` `"imports"` + relative path resolution.
   - *Verified repo fact*: `acorn` and `espree` are already installed transitively under `apiOpenArt/node_modules/` (via `eslint`), though neither is a direct dependency in `apiOpenArt/package.json` (`lines 44-79`).
2. **Declarative System Registry (`systems-manifest.json` — proposed)**: Map each System slug to `{ rootDir, entryFile, importAlias, tier, allowedSystems, ownedTables, ownedRpcs, errorPrefix }` so boundary checks are data-driven rather than hardcoded regexes.
3. **One-Way Ratchet Invariant (`ratchet.cjs`)**:
   - Keep `ratchet.compare` and `ratchet.shrink`: baseline counts in `arch-baseline.json` **may only go down**.
   - Every newly modularized System enters the manifest with **zero** baseline allowance (`0` permitted violations on `B1`–`B9`).
   - Add a gate assertion comparing `arch-baseline.json` against `git show HEAD:arch-baseline.json` (when in git) to fail automatically if any key's allowed count increases or a new key is added outside `--init-baseline`.

---

## 3. Proposed Boundary Checks (`B1`–`B10`)

### `B1` — Single-Entry Alias Hygiene (`package.json` `"imports"`) — *Rule 3*
- **Target**: `apiOpenArt/package.json` `"imports"` object.
- **AST/JSON Check**: Every alias belonging to a declared Business System must map to an exact `./src/.../<system>/index.js` path and contain zero `*` wildcards.
- **Violation Key**: `B1|package.json#<alias>`.

### `B2` — Encapsulation: No Deep Imports into System Internals — *Rule 3*
- **Target**: All `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`, `ImportExpression`, and `require()` calls across `CODE_DIRS`.
- **AST Check**: Resolve target file path. If target lies inside System `S` (`S.rootDir`) and caller lies outside `S.rootDir`, target **must** equal `S.entryFile` (`index.js`). Relative imports crossing `S.rootDir` are forbidden even if targeting `index.js` (must use `S.importAlias`).
- **Crucial Note on Relative Imports**: Package aliases in `package.json` `"imports"` (such as `"#platform/storage": "./src/platform/storage/index.js"`) block package-specifier deep imports like `#platform/storage/StorageService.js`, but Node ESM **does not block relative deep imports** (e.g., `../../src/platform/storage/StorageService.js`) which resolve directly against the filesystem. Therefore, an explicit mechanical check (`arch-check.cjs` AST visitor or `dependency-cruiser`) is required to forbid any production import resolving into `src/platform/storage/**` from outside, allowing entry solely through `index.js` (with an opt-in allowlist restricted to test files under `tests/**`).
- **Violation Key**: `B2|<callerRelPath>`.

### `B3` — Downward Dependency Direction & Allowed Matrix — *Rule 6*
- **Target**: Resolved System-to-System and System-to-Layer edges.
- **AST Check**:
  1. `Foundation` Systems (`Identity/Security`, `Storage`, `Billing`, `Models`, `Media`) must have zero imports resolving to `Upper Domain` Systems, `src/use-cases/`, `src/v2/`, `UseCaseService`, `controllers/`, or `routes/`.
  2. Any System `A` importing System `B` must list `B` in `A.allowedSystems`.
  3. Business Systems must never import from `controllers/`, `routes/`, `src/workers/`, `src/use-cases/`, or `src/v2/`.
- **Violation Key**: `B3|<callerRelPath>-><targetSystemOrLayer>`.

### `B4` — Acyclic Graph (Static Imports & Runtime Setter Wiring) — *Rules 6, 9*
- **Target**: Full resolved file and System import graphs + `CallExpression` AST nodes in composition files.
- **AST Check**:
  1. Run Tarjan strongly-connected-components (SCC) at both System level and intra-System file level; fail on any cycle (`SCC.length > 1`).
  2. Flag `MemberExpression` calls matching `/^set[A-Z]\w*(Service|Handlers)$/` (`setWorkflowService`, `setEntitySyncHandlers`) that inject cross-System references after construction.
- **Violation Key**: `B4|<cycleCanonicalKey>` / `B4|<fileRelPath>`.

### `B5` — Data & Repository Ownership Isolation — *Rules 5, 7*
- **Target**: Imports and `CallExpression` chains across `CODE_DIRS`.
- **AST Check**:
  1. **Client isolation**: Imports of `lib/supabase.js` or `@supabase/supabase-js` are prohibited outside `*Repository.js`, `lib/supabase.js`, and explicit boot/health modules (`routes/ready.js`, `src/container.js`).
  2. **Repository privacy**: A `*Repository.js` file owned by System `S` cannot be imported outside `S.rootDir` (and approved container wiring until System `index.js` composition replaces global `db`).
  3. **Table & RPC ownership**: Inside `*Repository.js`, string literal arguments to `.from("<tableName>")` and `.rpc("<rpcName>")` must belong to the owning System's `ownedTables` / `ownedRpcs` (unless declared as a read-only Documented Read Model with zero `.insert`/`.update`/`.upsert`/`.delete` calls).
  4. **Shared `db` bag ban**: Flag `MemberExpression` patterns `this.db.<repo>` or `db.<repo>` inside System services.
- **Violation Key**: `B5|<fileRelPath>`.

### `B6` — Thin Controller & Single-Coordinator Boundary — *Rules 8, 12*
- **Target**: `routes/**` and `controllers/**` (superseding regex `R1`).
- **AST Check**:
  1. Forbid imports of `*Repository*`, `lib/supabase.js`, `@supabase/*`, Platform `StorageService`, or BullMQ queues.
  2. Forbid `NewExpression` instantiating any `*Service` or `*Repository` inside route/controller files.
  3. Per exported handler function, flag invocations touching more than one Business System / Application coordinator (enforcing single delegation).
- **Violation Key**: `B6|<controllerRelPath>`.

### `B7` — Public Surface Contract & Export Hygiene — *Rules 3, 4, 8*
- **Target**: Every declared System `index.js`.
- **AST Check**:
  1. Forbid re-exporting symbols matching `Repository$`, `Supabase`, or unprefixed `ValidationError` / `QuotaError` / `UploadError` (once transitional exceptions expire).
  2. Require every exported capability function to carry an attached leading JSDoc block containing `@param`, `@returns`, and `@throws`, and require at least two parameters `(input, ctx)` (or explicit `@public-unauthenticated` annotation for public catalog queries like `getCatalog`).
- **Violation Key**: `B7|<systemEntryRelPath>`.

### `B8` — System-Prefixed Error Discipline — *Rules 7, 8*
- **Target**: `ThrowStatement` and `ExportNamedDeclaration` inside System folders.
- **AST Check**:
  1. Disallow `throw new Error(...)` (`NewExpression` where `callee.name === "Error"`).
  2. Every `class <Name> extends ...` exported from a System's `errors` module must start with `S.errorPrefix` (e.g. `Media*Error`).
- **Violation Key**: `B8|<fileRelPath>`.

### `B9` — Explicit Context Only (No Implicit `AsyncLocalStorage` Reads) — *Rule 11*
- **Target**: All Business Systems, Repositories, and Application coordinators.
- **AST Check**: Forbid importing or calling `getContext` / `getCleanContext` from `src/infrastructure/logging/` outside `src/infrastructure/logging/` and HTTP tracing middleware.
- **Violation Key**: `B9|<fileRelPath>`.

### `B10` — AST Upgrade for Existing Mechanical Rules (`R2`, `R3`, `R8`, `R9`)
- **Target**: Replace line-regex false positives/negatives while keeping rule IDs or mapping 1:1:
  - `R2`: `CallExpression` on `MemberExpression` `console.<method>` (ignores strings/comments; catches multi-line calls).
  - `R3`: `MemberExpression` `process.env` outside approved config modules.
  - `R8`: `CallExpression` `require(...)` nested inside `MethodDefinition` / `FunctionDeclaration`.
  - `R9`: `ClassDeclaration` in `*Service.js` verified to have a leading comment matching `/@owns\s+\S/`.

---

## 4. Open Decisions (Require Human Approval Before Any Implementation)

1. **AST Parser Dependency**: Neither `acorn` nor `eslint` is listed directly in `apiOpenArt/package.json` (`lines 73-79` list `eslint-plugin-react-hooks`, pulling `acorn`, `espree`, and `eslint` in transitively under `node_modules/`). Should we pin `acorn` directly in `devDependencies` for a standalone fast `arch-check.cjs`, or pin `eslint` and implement `B2`–`B10` as local ESLint rules?
2. **Manifest Location**: Store System boundary metadata in a dedicated `apiOpenArt/systems-manifest.json` read by `arch-check.cjs`, or parse YAML frontmatter from `docs/architecture/systems/<system>/SYSTEM.md`?
3. **Rollout Strategy**: Enforce `B1`–`B9` strictly (`allowed = 0`) **only** on Systems as each passes its approved Rule 15 phase (opt-in per System), or initialize a full-repo `arch-baseline.json` snapshot upfront and ratchet down?
