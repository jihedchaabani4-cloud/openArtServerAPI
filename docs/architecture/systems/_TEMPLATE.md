# `<SystemName>` System (`SYSTEM.md`)

> Copy this template to `docs/architecture/systems/<system-slug>/SYSTEM.md` during Step 2 (Proposal) of Rule 15 (`docs/architecture/BUSINESS_SYSTEMS_RULES.md`).
> Cite verified `file:line` for every claim about current code; write `UNVERIFIED` if not inspected in the current session. Never resolve `Open Decisions` unilaterally.

| Metadata | Value |
|---|---|
| **System Name** | `<SystemName>` |
| **Tier** | `Foundation` \| `Upper Domain` |
| **Public Import Alias** | `#systems/<system-slug>` *(or approved alias in `apiOpenArt/package.json`)* |
| **Entry File** | `apiOpenArt/src/.../<system-slug>/index.js` |
| **Base Error Class** | `<SystemName>Error` |
| **Audit Classification** | `KEEP` \| `REFACTOR` \| `SPLIT` \| `REBUILD` \| `MERGE` |
| **Phase Status** | `Audit` \| `Proposed` \| `Approved (Phase N)` \| `In Progress` \| `Verified` |

---

## 1. Purpose

- **Business Responsibility**: `<One to two sentences stating the exact domain invariants and lifecycle this System owns.>`
- **Qualification Proof (Rule 2)**:
  - **Persistent State Owned**: `<Postgres tables or approved Foundation resource>`
  - **External Consumers (>= 2)**: `<List distinct callers: e.g., Application coordinators, Upper Systems, HTTP controllers>`
- **Explicit Non-Goals**: `<Responsibilities that stay outside this System boundary.>`

---

## 2. Owns (Tables, Entities)

### Owned Database Tables & SQL RPCs (Rule 5)
| Postgres Table / RPC | Repository (`private`) | Key Invariants / Constraints |
|---|---|---|
| `public.<table_name>` | `<Name>Repository.js` | `<e.g., RLS service_role only, unique index, quota RPC>` |

### Owned Domain Entities, Policies & Quotas
| Entity / Constant | File (`file:line`) | Description |
|---|---|---|
| `<EntityName / QUOTA_CONST>` | `<path:line or TARGET>` | `<Canonical domain concept from GLOSSARY.md>` |

### Documented Read-Model Exceptions (if any)
- `<None — or list read-only multi-table projections with justification, caller, and zero-mutation guarantee.>`

---

## 3. Public Capabilities

Exported **exclusively** from `index.js` (Rules 3, 4, 11). Every capability uses a verb-noun name, JSDoc `@typedef` DTOs, compiled Ajv boundary schema, explicit `ctx` parameter, and `<SystemName>*Error` throws.

### Summary Table
| Capability (`verbNoun`) | Mode (`Sync`/`Async`) | Input `@typedef` + Ajv Schema | Output `@typedef` | Thrown Errors (`<System>*Error`) | Auth & Tenancy (`ctx`) |
|---|---|---|---|---|---|
| `<verbNoun>` | `Sync` \| `Async (Queue)` | `<InputType>` (`<schemaId>`) + `ctx` | `<OutputDto>` | `<SystemValidationError>`, `<SystemNotFoundError>` | `ctx.userId` + `ctx.projectId` -> `404` on mismatch |

### Capability Contracts
#### `<verbNoun>(input, ctx)`
- **Input (`@typedef`)**: `<Fields, types, bounds; validated via Ajv>`
- **Context (`ctx`)**: `{ userId: string, projectId?: string, reservationId?: string, requestId?: string }`
- **Output (`@typedef`)**: `<DTO fields — never raw DB rows>`
- **Errors**: `<Explicit list of <SystemName>*Error subclasses and HTTP status mapping>`
- **Auth**: `<How ownership is verified; cross-tenant always throws 404 NotFound>`
- **Idempotency & Compensation (Rule 10)**: `<Idempotency key + reverse rollback order with === true confirmation>`

---

## 4. Internal Services (Private)

Private to this System; never exported from `index.js` or imported by external modules (Rule 7).

| Component | File (`file:line`) | `@owns` Statement | Constructor Dependencies | Unit Test File |
|---|---|---|---|---|
| `<Name>Service` | `<path:line>` | `<Single sentence>` | `<repo, downwardSystem, logger>` | `tests/unit/<name>.test.js` |
| `<Name>Repository` | `<path:line>` | `Persistence for public.<table>` | `<supabaseClient>` | `tests/unit/<name>Repo.test.js` |

---

## 5. Allowed Dependencies

Dependencies point strictly downward (Rule 6). List only System public aliases and Platform primitives.

| Target | Kind (`Foundation System` / `Upper System` / `Platform`) | Import Specifier | Reason |
|---|---|---|---|
| `<Storage>` | `Foundation System` | `#systems/storage` *(or current alias)* | `<Binary upload / discard>` |
| `Logging` | `Platform` | `src/infrastructure/logging/index.js` | `createLogger("<module>")` |

---

## 6. Forbidden Dependencies

Explicitly prohibited imports and runtime couplings for this System (Rules 3, 5, 6, 9):

- **Upward / Peer Systems**: `<e.g., Foundation Systems must never import Element, Character, Project, Workflow, UseCaseService, or src/v2/>`
- **Foreign Persistence**: Direct imports of `lib/supabase.js` in `*Service.js`, foreign `*Repository.js` classes, or the shared `db` bag from `src/container.js`.
- **Deep Internals**: Any path inside another System other than its single `index.js` alias.
- **Cyclic Callbacks**: Runtime setter hooks (`set*Service`, `set*Handlers`) wiring upward dependencies.
- **Implicit Context**: Reading `getContext()` from `AsyncLocalStorage` for tenancy or billing decisions.

---

## 7. Error Classes

All public errors extend `<SystemName>Error` with a `<SystemName>` prefix (Rule 8). Controllers map `5xx` to masked `INTERNAL_ERROR` via `safePublicRouteError`.

| Error Class | `code` | `statusCode` | `retryable` | Safe Public Message | When Thrown |
|---|---|---|---|---|---|
| `<SystemName>Error` | `<SYSTEM>_ERROR` | `500` | `false` | `"Internal server error"` | Base class for all System errors |
| `<SystemName>ValidationError` | `<SYSTEM>_VALIDATION_ERROR` | `400` / `413` / `415` | `false` | `<Field-safe message>` | Ajv schema or domain invariant failure |
| `<SystemName>NotFoundError` | `NOT_FOUND` | `404` | `false` | `"Resource not found"` | Missing ID or cross-tenant `userId`/`projectId` mismatch |
| `<SystemName>QuotaError` | `LIMIT_EXCEEDED` | `400` | `false` | `<Quota message>` | Atomic domain quota exceeded |

---

## 8. Current Status

- **Current Files & Locations**: `<Exact paths + line counts, verified in session>`
- **Container Wiring (`apiOpenArt/src/container.js`)**: `<Exact lines and injected dependencies>`
- **`package.json` `"imports"` Entry**: `<Exact current alias or "missing">`
- **Existing Tests**: `<Unit, contract, boundary, and SQL disposable test paths>`
- **Summary Assessment**: `<What already matches Rules 1–13 vs what is transitional>`

---

## 9. Known Gaps

Evidence-backed deviations between Current Status and `BUSINESS_SYSTEMS_RULES.md`:

| ID | Rule Violated | Location (`file:line`) | Current Behavior | Target Fix | Planned Phase |
|---|---|---|---|---|---|
| `G1` | `Rule <N>` | `<path:line>` | `<Exact finding>` | `<Minimal target change>` | `Phase <M>` |

---

## 10. Open Decisions

Stop here until the human resolves every item below (Rule 15):

- [ ] **OD-1 — `<Decision Title>`**: `<Context + Option A vs Option B + Recommendation (1 sentence)>`

---

## 11. Definition of Done

A System phase is complete **only** when every applicable item is verified with command output:

- [ ] `SYSTEM.md` approved by human; zero unresolved `Open Decisions` for the active phase.
- [ ] Single `index.js` entry point mapped to one non-wildcard alias in `apiOpenArt/package.json` `"imports"` (Rule 3).
- [ ] Zero deep imports into this System from external files; zero forbidden imports from this System (Rules 3, 6).
- [ ] Every exported capability has verb-noun naming, `@typedef` DTOs, compiled Ajv validation, explicit `ctx`, and `<SystemName>*Error` throws (Rules 4, 8, 11).
- [ ] Owned tables queried exclusively by private `*Repository.js`; zero raw `supabase` calls in `*Service.js`; zero shared `db` bag usage (Rules 5, 7).
- [ ] Every `*Service.js` has `@owns` header, fail-closed constructor, `createLogger`, and unit tests (Rule 7).
- [ ] Public surface contract tests (`tests/.../<system>Contract.test.js`) cover happy path, Ajv refusals, cross-tenant `404`, partial-failure rollback (`=== true`), and idempotency (Rules 10, 13).
- [ ] Container wiring verified in `tests/boundary/containerWiringBoundary.test.js` and catalog regenerated via `npm run catalog`.
- [ ] `cd apiOpenArt && npm run gate` passes (`GATE SUMMARY` pasted) and `node scripts/arch-check.cjs --shrink-baseline` lowers `arch-baseline.json` where violations were removed (Rule 14).
- [ ] Full `git diff` reviewed against phase scope; awaiting explicit human approval before `git commit` (Rule 15).
