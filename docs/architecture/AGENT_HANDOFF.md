# OpenArt Backend: Business Systems Master Plan and Agent Handoff

Save this file as `docs/architecture/AGENT_HANDOFF.md`.
Any AI agent (Claude, ChatGPT, Gemini, Cursor, Codex, ...) must read it COMPLETELY before doing anything.
The human should only need to say `next`.

---

## 0. Command protocol (how the human drives you)

| Human says | You do |
|---|---|
| `next` | Read `docs/architecture/STATUS.md`, verify it against git, do the next unit of work (section 5), update STATUS.md, send the report (section 8), STOP. |
| `status` | Report only. No changes. |
| `decide: <id> = <choice>` | Record the decision in STATUS.md and the system doc, then continue with `next` logic. |
| `depth: <system or service>` | Start a Depth Pass (section 7) for that target. |
| `stop` | Stop immediately, leave the tree clean, report. |

Never do more than ONE unit of work per `next` (one system in the Base Pass). Never continue by yourself.

---

## 1. Goal and target architecture

Modular Monolith of encapsulated Business Systems: one app, one process, one API.
- A **Business System** owns its tables, internal services, repositories, and error classes.
- A system exposes a small deliberate **public surface** through ONE `index.js` and ONE exact alias in `package.json` "imports".
- Other systems and the application layer use only that surface. No deep imports, no foreign table access.
- Dependencies point downward only. No cycles.
- Controllers stay thin. Orchestration across systems belongs to the Execution Engine / application layer.
- `container.js` is the only place that creates instances. `index.js` exports classes and factories, never singletons.
- Stack: Node.js ESM JavaScript, Express, Supabase (Postgres), BullMQ/Redis. Repo: `apiOpenArt` is a git submodule of the root repo.

Governing docs (read them): `docs/architecture/BUSINESS_SYSTEMS_RULES.md`, `systems/_TEMPLATE.md`, `ENFORCEMENT_PROPOSAL.md`, root `AGENTS.md`, `apiOpenArt/AGENTS.md`.

---

## 2. Two phases

**Base Pass (current):** breadth first. Turn every system into a module with clear boundaries. Behavior-preserving, mechanical work only. Anything else found goes to `docs/architecture/BACKLOG.md`, never fixed here.

**Depth Pass (on demand):** the human picks a system or service. Full audit and real fixes, with approval before implementation.

---

## 3. Non-negotiable rules

1. **Behavior-preserving in the Base Pass.** No SQL changes, no new behavior, no security fixes, no retry/billing logic changes, no test rewrites except import-path updates. Found problem = BACKLOG entry (id, system, severity, one line, file:line with verbatim excerpt).
2. **Git hygiene.** Local commits only. Never push, amend, rebase, `reset --hard`, or force anything. Explicit `git add <path>` only, never `-A` or `.`. Never stage `.agents/`, `.scratch/`, `scripts/` (root), `graphify-out/`, `my-app`, migrations, ADRs, or the pending Media refactor files. Never commit the submodule pointer unless told.
3. **Evidence rule.** Every `file:line` claim needs the VERBATIM excerpt. Anything you did not run or read in THIS session is written as `UNVERIFIED`. Do not estimate numbers.
4. **Gate rule.** `cd apiOpenArt && npm run gate` must pass after every commit. A gate in a dirty working tree is NOT proof. Verify each commit in a clean worktree (`apiOpenArt/scripts/clean-gate.ps1` if present; it uses a worktree inside the root folder, which still sees root files, so state this limit). Report counts you measured, never remembered ones.
5. **SQL rule.** Every column or table name used in code must be checked against `supabase/migrations/20261018161500_baseline.sql` plus later migrations. Never invent columns. (This already happened once: a 13-column select with nonexistent columns was written and caught before commit.)
6. **Test rule.** Tests must exercise real behavior. A test double must replicate the real error shape and message of the thing it replaces. Never assert a canned mock return value.
7. **Errors.** A change of error type or HTTP status is a behavior change: grep every catch and inspect site first, record it explicitly. Keep legacy `errorCode` fields when code or tests read them.
8. **No trust in your own earlier reports.** Re-verify state from git, not from memory or previous summaries.
9. **Ratchet.** `arch-check` baseline may only shrink. Run the service-catalog regeneration when the gate asks.
10. **Honesty.** If two facts contradict, stop and report the contradiction. Do not pick one.

### STOP conditions (stop at once, make no further commits, report)
- A clean-worktree gate fails or its count is unexpected.
- A check contradicts something written in this file or in STATUS.md.
- You find a path that can lose, duplicate, or fail to refund user money that is not already in BACKLOG.
- A change would alter production behavior in a way the step does not describe.
- The same gate failure happens twice on the same step.

---

## 4. Systems, ownership, and order

Dependencies point downward. Build order is top to bottom.

| # | System | Contains (services inside) | Owns |
|---|---|---|---|
| 1 | **Storage** | StorageService, path resolver, providers, error classes | physical bucket only, no tables |
| 2 | **Billing** | WalletService, FailedOps, reaper, payments, credit packages, repositories | wallet, transactions, subscriptions, credit_packages, usage_events, failed_wallet_operations |
| 3 | **Identity** | auth controller, AuthorizationService, TenantAccessService, ownership guards (assertOwns...), AuditService, requireAdmin | profiles, auth cookies/JWT handling, audit |
| 4 | **Models** | model registry, binding resolver, provider runtime, PricingService (moved here), Prompt and LLM services | model config, pricing_rules |
| 5 | **Media** | MediaService, MediaUploadService, inspector, source policies | public.media |
| 6 | **Workspace** | projects, folders, workflows, workflow_media, trash, characters, elements | project, folders, workflow, workflow_media, trash, characters, elements |
| 7 | **Execution Engine** | V2 runner, use cases, queues, workers, gateways | v2_workflow_runs, v2_workflow_run_nodes |

Platform (not systems): logger, redis, config, rate limiter, error base classes.
Open question for the Identity run: does `WorkflowAuthorizationService` belong to Identity or Workspace? Do not move it in the Base Pass; record the decision needed.

Recommended base order: Identity, Models, Media, Workspace, Execution Engine (Storage and Billing are done).

---

## 5. Base Pass: the unit of work per `next`

One system per run, at most 3 commits.

**Checklist (B1 to B6):**
- **B1** One exact alias in `package.json` "imports" pointing to the system's `index.js`. Remove that system's wildcard alias only after grepping every usage (src, tests, scripts, controllers).
- **B2** `index.js` = public surface only. No internals, no singletons. Factories allowed (like `createStorageService`).
- **B3** Base error class with the system prefix extending `AppError`. Keep legacy `errorCode`. Do not rename existing thrown classes unless grep shows nothing depends on them; otherwise note it in BACKLOG.
- **B4** Mechanical cleanup: replace deep imports of internals from outside with the alias (tests may use the relative `index.js`); remove constructor dependencies that are injected but never used.
- **B5** `docs/architecture/systems/<system>.md`, one page max: purpose, owned tables, internal services, public API (list of exports), allowed dependencies, known gaps (BACKLOG ids). Facts with verbatim `file:line`.
- **B6** `arch-check` no new violations. Gate passes.

**Commits per system:** (1) alias + index + errors, (2) deep-import and dead-dependency cleanup, (3) SYSTEM.md.

**Reference implementations:** Storage (`src/platform/storage/`) and Billing (`src/platform/billing/`). Follow their conventions: `createXService({ client })` factory, fail-closed when a dependency is missing, typed errors.

---

## 6. Known verified facts (re-verify before relying; quote the lines)

- `apiOpenArt/lib/supabase.js`: `supabase`, `supabaseAdmin` and `createRequestBoundClient` all use `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY`. There is no anon client in the backend. RLS protects nothing; tenant isolation is application code only (`ownership.js`, `.eq("user_id")`). About 12 repositories import this client. This is a HIGH BACKLOG item scheduled as the first target of the Identity depth pass.
- `WalletService` has non-atomic table fallbacks (`holdFallback`, `rollbackFallback`, `creditFallback`) reachable only on PGRST202 / "schema cache". Scheduled as backlog item G15 (remove, fail closed).
- Payment idempotency relies on `transactions_reference_id_key` (UNIQUE) in `baseline.sql`; `WalletService.credit` maps 23505 to `DUPLICATE_TRANSACTION`; the webhook returns 200 "Already processed".
- Past session errors to avoid: invented column names; claims about the anon client made without quoting `lib/supabase.js`; gate counts taken from a dirty working tree.

---

## 7. Depth Pass (only when the human says `depth: <target>`)

1. **Audit, no code.** Write or update `systems/<system>.md` with: Current Architecture (what the code really does, verbatim excerpts), Target Architecture, Gaps (severity, files), Public Capabilities (input, output, errors, auth), Unresolved Decisions. Mark unverified claims.
2. **STOP** and wait for explicit approval of a specific phase.
3. **Implement ONE approved phase.** Grep all callers first. Preserve unrelated behavior. Tests for any changed behavior (real, not canned).
4. Run the gate in a clean worktree. Show the full diff. **STOP.** No commit without an explicit `go`.
5. Money, auth, or tenant-isolation changes: show the diff to the human even if the gate passes.

Suggested depth targets, by value: (a) Identity: service-role client and tenant-isolation sweep, (b) Billing G15 fallbacks, (c) FailedOps gaps, (d) Storage error message prefix `[StorageService]` reaching clients, (e) Media upload pipeline.

---

## 8. Report format (max 25 lines, after every unit)

1. Commits: hash | message | files | clean-gate count measured this session.
2. B1 to B6: done / partial / skipped, one line each with the reason.
3. New exports on `index.js`.
4. BACKLOG additions (id, severity).
5. Open decisions for the human (max 3).
6. What you did NOT touch.
7. Next unit proposed.

No diffs in the report unless a commit changed production logic.

---

## 9. State tracking: `docs/architecture/STATUS.md`

You maintain this file. It is the single source of truth. Update it at the end of every unit and commit it with the docs commit. Template:

```
# STATUS (updated by the agent after every unit)
Last updated: <date> | HEAD apiOpenArt: <hash> | HEAD root: <hash>

| System | Base pass | Depth pass | Last commits | Notes / BACKLOG ids |
|---|---|---|---|---|
| Storage | DONE | partial | ... | ... |
| Billing | DONE | partial | ... | G11-G15, 1a-2 |
| Identity | TODO | - | | |
| Models | TODO | - | | |
| Media | TODO | - | | |
| Workspace | TODO | - | | |
| Execution Engine | TODO | - | | |

Open decisions: ...
Next unit: ...
```

### Initial state (as of the last human report; VERIFY with `git log` before trusting)
- **Storage:** base pass done plus follow-ups. Known commits (apiOpenArt): ab011b6, b3e22eb, 7850db4, be13e60, 036ce6d, 66dc827, 6e78ca0, f7a9041.
- **Billing:** base pass done. Known commits: 688eeb3, 43942e2, 07046c5, c8ad63b, 537bde0, f1a4772, 26b4187, a7b6614, 0e800b2, 20f6f47, bb14851. Root docs: 19e6fe5.
- **Possibly still uncommitted at that time (check `git status`):** queue error listeners (staged; the committed test file must be the version WITHOUT `close()` hooks, which hung the gate), `walletServiceIdempotency.test.js` and the skipped Postgres integration test (UNVERIFIED, no Docker), the governing docs (`BUSINESS_SYSTEMS_RULES.md`, `ENFORCEMENT_PROPOSAL.md`, `_TEMPLATE.md`, `backend-modularization-context.md`, `AGENTS.md` change), `billing.md` corrections (the earlier "anon client" claims were wrong).
- **Step 0 before the first `next` of Identity** (if not already done): commit the governing docs; commit the billing.md corrections (do not amend 19e6fe5); finish the queue-listeners and idempotency-tests commits; create `BACKLOG.md` and `STATUS.md`; move G15, 1a-2, txRepo alias, FailedOps gaps G11 to G14, tests that read `../../../supabase/migrations`, the integration test UNVERIFIED, and the service-role HIGH finding into BACKLOG.

---

## 10. First message from the human to a new agent

> Read `docs/architecture/AGENT_HANDOFF.md` completely and follow it. Start with `status`.
> After that I will only send `next`, `status`, `decide: ...`, `depth: ...` or `stop`.
