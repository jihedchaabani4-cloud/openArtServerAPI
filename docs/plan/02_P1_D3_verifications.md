# Phase P1: task D3 (verifications)

> Read `00_CORE.md` completely BEFORE this file (rules, loop, rubric, decisions). Section numbers are those of the original plan; the index in `00_CORE.md` says where each section lives.
> Scope of THIS file: section 5 (D3). Do not read or start other phase files.
> Prerequisites: Phase P0 is DONE (check `docs/plan/STATE.md` and `docs/plan/reports/D2.6.md`). If not, STOP and say so.

## Order of work in this session

1. If `SPEC_KIT = ON`: PREP-P1 first (`05_SPEC_KIT_GUIDE.md`) using THIS file as the spec, STOP, wait for `GO`. If OFF: start directly.
2. Task D3, sub-items 1 to 5 (one commit, or one per sub-item).
3. Phase gate, acceptance test, STOP.

---

## 5. Phase P1: task D3 (verifications)

Rule for the whole task: VERIFY first, then fix ONLY what is clearly wrong. Each fix has a failing test first. One report `docs/plan/reports/D3.md` with five sections. Commit(s): `phase0(RC1.4-D3)` (or one per sub-item: `phase0(RC1.4-D3.1)` ... `D3.5`). Do NOT start F3, F4, F5, F7.

### D3(1): memory fallbacks must be impossible outside tests

**Plain words.** `RunRepository` (and `lib/supabase.js`) may have a "memory fallback": a way to store data in RAM instead of the database. That is fine for unit tests. It is a disaster in production: if the DB has a hiccup, runs would silently be stored in RAM and disappear on restart, while users believe they are saved.

**Questions to answer (with `file:line` evidence)**
1. What is the default value of `useMemoryFallback`?
2. Who sets it (constructor argument? env var? a `catch` block that flips it after an error?). Search: `rg -n "useMemoryFallback|memoryFallback|inMemory|new Map\(\)" src/ lib/`.
3. Can a DB error EVER cause a switch to memory in non-test code? Read every `catch` around DB calls in `RunRepository`. Look for assignments like `this.useMemoryFallback = true`.
4. Same questions for the test fallbacks in `lib/supabase.js` (for example a fake client returned when env vars are missing).

**Required end state**
- Outside `NODE_ENV=test`, memory fallback can never be enabled, by constructor, env var, or error handling. If someone tries (config says so) or a DB error occurs, the code THROWS (fails loudly) and logs at error level via the structured logger.
- In `lib/supabase.js`: if Supabase env vars are missing and `NODE_ENV !== 'test'`, the app must fail at boot with a clear error. A fake client is allowed only when `NODE_ENV === 'test'`.

**Tests (write first)**
| # | Given | Then |
|---|---|---|
| 1 | `NODE_ENV=production`, repository constructed with fallback enabled | constructor throws |
| 2 | `NODE_ENV=development`, same | throws |
| 3 | `NODE_ENV=production`, DB call rejects | the error propagates (promise rejects) and the repository did NOT switch to memory (next call still uses the DB mock) |
| 4 | `NODE_ENV=test`, fallback enabled | works as before (regression for existing tests) |
| 5 | `lib/supabase.js` with missing env and `NODE_ENV=production` | throws at load/creation |
| 6 | same with `NODE_ENV=test` | returns the test fake |

Test technique: set `process.env.NODE_ENV` inside the test, restore it in `afterEach`. If the module reads `NODE_ENV` at import time, load it with `jest.isolateModules` / dynamic `import()` (match the repo's framework) after setting the env.

**Pitfall:** do not break the existing test-suite (it likely relies on fallback). Check `NODE_ENV` is really `test` when `npm test` runs (`rg -n "NODE_ENV" package.json jest.config.* vitest.config.*`). If tests do not set it, set it in the test setup file, not in production code.

### D3(2): LLM price and credit arithmetic

**Questions to answer**
1. Run `calculateWorkflowBillingPlan` for the 3 use cases with the REAL manifests (find them: `rg -n "calculateWorkflowBillingPlan" src/ lib/` and look where manifests live, probably JSON/JS files describing models and costs). Show for each use case: input, the full output, and the exact value(s) passed to `hold_credits`.
2. Are those values INTEGER or DECIMAL? Is rounding applied (`Math.ceil`, `Math.round`, none)?
3. Reconcile "gemini-3.1-flash-lite costs 0.05 credits" with the earlier sweep that said "1 credit". Find which is correct today and WHY the numbers differ (different unit? a minimum charge? rounding up of 0.05 to 1? a stale doc?).
4. Wallet balance column: integer or decimal? Find the SQL definition: `rg -n "hold_credits|balance|credits" migrations/ db/ supabase/` and read the function and the table definition.

**How to run the billing plan without network/DB**
- Write a throwaway script `/tmp/billing-plan.mjs` (not committed) or a temporary test that imports the function and loads the real manifests. If the function needs the DB or network, stub only those parts (for example a fake price lookup that reads the manifest). Print a table. Copy the table into the report.
- If you cannot run it hermetically, report `NOT-RUN` and show the code path by reading it, tagging the conclusions INFERRED.

**Table to put in the report**
| use case | model | manifest cost (value + unit) | plan total | value passed to hold_credits | JS type | rounding applied |
|---|---|---|---|---|---|---|

**Decision rules (apply in order)**
- If the code does FLOAT arithmetic on balance/hold amounts and a drift or wrong rounding is demonstrable (for example `0.1 + 0.2` style errors, or a hold smaller than the final charge): fix the code path with a failing test first. Prefer integer minor units in code (for example credits x 100 internally) ONLY if the DB column is already integer/numeric and changing code alone is safe.
- If the DB wallet column is `float`/`double precision`: do NOT migrate it in this task. Document the risk, add a BACKLOG item (severity High) proposing a migration to `numeric`/integer minor units, and make sure code rounds consistently.
- If the column is integer and the code passes decimals (or the opposite): that is a clear bug. Fix with a test.
- If everything is consistent (exact numeric type + explicit rounding rule) and the 0.05 vs 1 difference is just minimum-charge rounding: document the rule precisely in `docs/release/phase0-rc.md` and change nothing.
- Never redesign the wallet in this task.

**Pitfall:** a hold smaller than the final charge lets users go negative; a hold larger than needed must be released/refunded for the difference. Check both directions and report.

### D3(3): entrypoint table and idempotent failure handler

**Step 1: find every process**
- `cat package.json | rg -n '"(start|dev|worker|build)[^"]*"'` and look at all `scripts`.
- Look for deployment files that start processes: `ls Dockerfile* docker-compose* Procfile render.yaml railway.* fly.toml 2>/dev/null` and read the start commands.
- Look for files with names like `*Worker.js`, `server.js`, `index.js`, `app.js` and the folder `workers/`.

**Step 2: for each process, fill this table**
| Process | Entry file | Imports `container.js`? (boot assertions run?) | Env vars it needs (from `rg -n "process.env\." <reachable files>`) | If an env var is missing: fails fast or silent? |
|---|---|---|---|---|
| API server | | | | |
| useCaseWorker | | | | |
| reservationReaperWorker | | | | |
| other workers | | | | |

To know "imports container.js" follow the import chain from the entry file (open each import, or `rg -n "container" <entry file>`). A process that does NOT run the boot assertions can start with a broken configuration. If one is found: make it import/run the same assertions (small change + test that boot fails when a required env var is missing).

**Step 3: the `failed` handler of `useCaseWorker` must be idempotent**
- Find it: `rg -n "on\('failed'|\.on\(\"failed\"|failed" src/workers/ src/` (queue libraries like BullMQ emit a `failed` event).
- Read what it does: usually releases/refunds a credit hold and marks a run as failed. Question: what happens if the handler runs TWICE for the same job (retry, duplicate event, process restart)?
- It is idempotent only if the second run changes nothing. Look for: a conditional update (`update ... where status = 'held'`), a unique key on the refund, or an RPC that checks state first. If it is simply "refund N credits", it is NOT idempotent.
- Test (write first): call the handler twice with the same job object; assert the refund/release function took effect once (balance restored once; or the release RPC reports "already released" and is a no-op).
- Fix if needed: make the release conditional on the reservation state (compare-and-set) so a second call is a no-op.

**Report:** the filled table + a sentence on idempotency with evidence and test name.

### D3(4): ownership tests assert 404 only

**Extra instruction for D3(4)**:
The 29 failing tests are the known pre-existing baseline (see `BACKLOG.md`). The 20 failing tests in `characterAndElementOwnership`, `projectOwnership`, `referenceAndMediaOwnership` and `collectionItemOwnership` fail because their harness sends `x-internal-secret` to routes that are no longer allowed (401). In D3(4), migrate those 4 suites to authenticate with a mock JWT/user (test-only change, no production code change for that), keep their cross-tenant assertions at exactly 404, and make sure the "legitimate owner -> 200" cases pass. Report before/after fail counts. Any failure that is not in the baseline list is a regression.

**Steps**
1. Find the tests: `rg -n "R4-GENERIC|assertOwns|ownership" tests/ test/ __tests__/` and the helper files.
2. Find places that accept 403: `rg -n "403|Forbidden|oneOf|\[403, ?404\]|toBeOneOf|anyOf" <those test files>`.
3. Change each assertion so cross-tenant access must be exactly 404 (assert the status AND that the response body does not reveal the record's data).
4. If a test now fails, a route really returns 403 for cross-tenant (or 500). That is a real bug: find where (`rg -n "403" src/routes src/middleware src/controllers`), fix it to return 404 (consistent with `assertOwns`), keep the failing test as the proof.
5. In addition to step 3-4, migrate the 4 legacy test suites (`characterAndElementOwnership`, `projectOwnership`, `referenceAndMediaOwnership`, `collectionItemOwnership`) from `x-internal-secret` to mock JWT/user authentication. Keep cross-tenant assertions at exactly 404 and legitimate owner assertions at 200.
6. Report: list of changed assertions (`file:line`), route fixes if any, and before/after fail counts.

### D3(5): repository methods without a `user_id` filter

**Plain words.** `BaseRepository.deleteById(id)` and `ElementRepository.list(...)` take no user filter. They are safe ONLY if every caller has already verified ownership. One forgotten caller = a user deleting or listing another user's data.

**Steps**
1. List EVERY caller (file:line):
```
rg -n "\.deleteById\(" src/ lib/ workers/ scripts/
rg -n "ElementRepository|elementRepository" src/ lib/ workers/ scripts/
rg -n "\.list\(" src/ lib/ workers/   # then keep only the ones on ElementRepository (follow the variable)
```
Also check subclasses: other repositories inherit `deleteById` from `BaseRepository`, so search for classes that `extends BaseRepository` and then find calls on their instances.
2. For each caller fill this table:
| Caller (file:line) | Route/process | What proves ownership before the call (`assertOwns`, a scoped query, the id comes from a server-created record) | Safe? |
|---|---|---|---|
3. Decide "safe" strictly: the proof must run BEFORE the call and must refer to the SAME id that is passed to `deleteById` or the same project/user that `list` uses. An `assertOwns` on a different id is NOT proof.
4. For every unsafe caller: write a failing test (user B tries to delete/list user A's record and must get 404 / an empty or scoped result), then fix by adding the ownership check or scoping the query.
5. Optional cheap hardening (only if it keeps the diff small): add a `userId` (or `scope`) parameter to these methods and rename the unscoped versions to something explicit like `deleteByIdUnscoped`, so nobody calls them by accident. If this touches more than about 10 call sites, do NOT do it; put it in BACKLOG.md.

### D3 acceptance
Five sub-reports with evidence; each fix has a test; full hermetic `npm test` green; secrets scan clean; self-review >= 85; commit(s); report `D3.md`; STATE.md updated. Then go to phase gate (section 10) and then P2.

---

## Phase end: gate and acceptance test

1. When every task above is DONE, BLOCKED or SKIPPED, run the phase gate (`00_CORE.md` section 10).
2. Phase acceptance test. Run each check and paste the results (command or test name + result, tagged VERIFIED / NOT-RUN) into `docs/plan/reports/PHASE-P1-GATE.md`:

Always: full hermetic `npm test` passes; `git status --short` clean (except `docs/plan/scratch/`); nothing pushed; every task of the phase has a report with tagged claims.

| Phase | Extra checks |
|---|---|
| P1 | (1) Report D3.md has the five sub-reports. (2) Memory-fallback tests exist and pass for `NODE_ENV=production` and `development`. (3) The billing table and the wallet column type are in the report. (4) The entrypoint table is complete (every process listed). (5) `rg -n "403" <ownership test files>` shows no accepted 403 for cross-tenant. (6) The caller table for `deleteById` and `ElementRepository.list` has every row marked safe or fixed with a test. |

If any check fails: fix it inside the phase (same loop), re-run the phase acceptance test, then report. Do not stop with a failed check unless a stop reason of 1.5 applies.

3. Write the gate report, update STATE.md with `Next step: P2 (human gives you `03_P2_audits.md` in a new session)`, print a summary (max 15 lines) and STOP.
