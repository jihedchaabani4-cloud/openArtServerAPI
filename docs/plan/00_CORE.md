# 00_CORE: rules, loop, review, decisions (read this with EVERY phase file)

> Place all plan files in `docs/plan/` of the backend repo.
> Audience: the coding agent. Assume you are a careful junior engineer who has never seen this repo before.
> Everything is explained step by step on purpose. Follow the steps literally. Do not skip steps because they look obvious.
> You review your own work (section 2.3), record your decisions (section 12), and stop only for the reasons in section 1.5 and at the end of your phase (RUN MODE).

## Where is each section (numbers are those of the original single-file plan)

| Section | File |
|---|---|
| RUN MODE, 0, 1, 2, 9, 10, 12 | `00_CORE.md` (this file) |
| 3 (SETUP-1, SETUP-2), 4 (D2.6) | `01_P0_setup_and_D2.6.md` |
| 5 (D3) | `02_P1_D3_verifications.md` |
| 6 (audits SES0, GEN1, NAM0, DM1) | `03_P2_audits.md` |
| 7 (Folders feature, 7.1 to 7.10) | `04_P3_folders.md` |
| 3.1 (Spec Kit workflow) | `05_SPEC_KIT_GUIDE.md` |
| 8 (locked P4), 11 (final summary) | `06_FINAL_AND_P4.md` |
| 13, 14 (prompts, human checklist) | `HUMAN_GUIDE.md` (for the human, not for the agent) |

When a text says "section N" or "7.3", open the file given by this table.

---

## RUN MODE (read this first)

`RUN_MODE = PHASE_STOP`. The human gives you ONE phase file per session and controls the pace.

- Read `AGENTS.md`, then this file (`00_CORE.md`) completely, then ONLY the phase file named in the prompt. Do not open or start other phase files.
- Run ALL tasks of that phase without stopping between tasks (loop in section 2.1).
- When the last task is done: do the phase gate (section 10) and the phase acceptance test written at the END of the phase file. Write the gate report, set in STATE.md the line `Next step: <what> (waiting for the human)`, print a summary of at most 15 lines (what was done, test results, what failed or is NOT-RUN, report file names), and STOP.
- Never start another phase by yourself. Starting early is a violation of this plan.

`SPEC_KIT = ON` or `OFF`: stated in the prompt. If the prompt does not say, use OFF.
- OFF: the task cards of the phase file are the only spec. Start directly with the first task.
- ON: for phases P0, P1 and P3 the session has two steps with a human stop between them. Step 1 is PREP: Spec Kit prepares the spec, plan and task list from the phase file (no code), then STOP so the human can read `tasks.md`. After the human writes `GO`, step 2 is IMPLEMENT (tasks, gate, STOP). Procedure in `05_SPEC_KIT_GUIDE.md`.
- Phase P2 (read-only audits) never uses Spec Kit.

Stops from section 1.5 always apply.

---

## 0. How to read these files

### 0.1 Reading order (saves your context window)

1. Read `AGENTS.md` first. If AGENTS.md and the plan files disagree, AGENTS.md wins.
2. Read this file (`00_CORE.md`) completely: rules, loop, review rubric, checklists, gates, decisions.
3. Read ONLY the phase file the human named in the prompt. Do not open other phase files.
4. Your current position is always in `docs/plan/STATE.md`.

### 0.2 Facts in the plan files are hints, not truth

Names of files, functions, routes and tables below (`auth.js`, `assertOwns`, `hold_credits`, `ElementVisionService`, `container.js`, `RunRepository`, `BaseRepository`, `ElementRepository`, `useCaseWorker`, `reservationReaperWorker`, `StorageService`, `sizeLimitedStorage.js`, `redis.js`, `lib/supabase.js`) come from earlier conversation notes. They were NOT checked against the code by whoever wrote this plan.

Rule: before you rely on any name, run a search and open the file. If the repo disagrees with this plan:
- For FACTS (what exists, what a function does): the repo wins.
- For INTENT (what we want to achieve): this plan wins.
- Write the difference as one line in `docs/plan/DECISIONS.md`.

### 0.3 Phase map (one phase = one file = one session)

| Phase | Content | Kind | File |
|---|---|---|---|
| P-1 + P0 | Setup, then D2.6 (internal-secret hardening, health/ready, logger, upload-cap docs, curl) | code | `01_P0_setup_and_D2.6.md` |
| P1 | D3: five verifications, fix only what is clearly wrong | code + fixes | `02_P1_D3_verifications.md` |
| P2 | Read-only audits: SES0, GEN1, NAM0, DM1 | read-only | `03_P2_audits.md` |
| P3 | Folders feature (project, folders, assets) | feature | `04_P3_folders.md` |
| P4 | F3, F4, F5, F7 | LOCKED, never start | `06_FINAL_AND_P4.md` |


---

## 1. Operating contract (non-negotiable)

### 1.1 Glossary (plain words)

Read this once. These words appear everywhere.

- **User / tenant**: one customer account. Data of one user must never be visible or changeable by another user.
- **Cross-tenant access**: user A reads or changes a record that belongs to user B. This is the worst class of bug in this project.
- **Impersonation**: acting as another user. Example: a request says "I am user 42" in a header, and the server believes it without proof.
- **Shared secret**: one password-like string known by several callers (here `INTERNAL_SECRET`). If it leaks, whoever holds it gets all the power the secret gives.
- **Allow-list**: list of things that ARE permitted (here: method + path pairs). Everything not listed is refused. The shorter the list, the safer.
- **Ownership check (`assertOwns`)**: server code that checks "does this record belong to the logged-in user?". Must run before using a record id that came from the client.
- **404 vs 403**: 403 means "exists but forbidden". 404 means "not found". For cross-tenant cases we ALWAYS answer 404, so an attacker cannot learn which ids exist.
- **Hermetic test**: a test that needs nothing from outside: no `.env` file, no network, no real database, no real clock or random dependency. It passes on any clean machine.
- **Failing test first**: write the test, run it, see it FAIL for the right reason, then write the fix, then see it PASS. This proves the test really tests the fix.
- **Idempotent**: doing the same operation twice has the same result as doing it once. Example: a "refund" handler that runs twice must not refund twice.
- **Additive migration**: a database change that only ADDS things (new table, new nullable column). It never deletes, renames, or changes the meaning of existing things. Old code keeps working.
- **Liveness (`/health`)**: "is the process alive?". Used by the platform to decide to restart it.
- **Readiness (`/ready`)**: "can the process serve real traffic right now?" (its dependencies, like Redis, are up). Used by the load balancer to decide to send traffic.
- **In-flight**: currently being processed (for uploads: bytes received but not finished).
- **Constant-time comparison**: comparing two secrets in a way that takes the same time whether they match or not (`crypto.timingSafeEqual`), so an attacker cannot guess the secret byte by byte.
- **Minor units**: storing money-like values as integers of the smallest unit (for example 1 credit = 100 units) to avoid float errors like `0.1 + 0.2 = 0.30000000000000004`.
- **Silent fallback**: when something fails and the code quietly switches to a weaker behavior (for example "DB failed, use in-memory storage instead"). Dangerous in production because data is lost without anyone knowing.
- **Composite foreign key**: a foreign key made of 2 columns. We use it so a row can only point to a parent in the SAME project.
- **Cycle**: folder A inside B and B inside A (directly or through other folders). Must be impossible.
- **Structured logger**: the project's logger module that writes JSON records with a level and fields. Never use `console.log` or `console.error`.
- **REUSED / EXTENDED / CREATED**: for every thing you touch, say whether you used it as is (REUSED), changed it (EXTENDED), or made it new (CREATED).
- **Escalation**: a short file that tells the human exactly what is blocking you (format in 2.6).
- **Backlog**: a list of problems you noticed but are NOT fixing now.
- **Naming map**: the table in 7.1.2 that says which product word (for example "Asset") corresponds to which REAL table, class and route (for example the `workflow` table). We keep the real names. We do NOT rename them in this plan.

### 1.2 Rules inherited from AGENTS.md (AGENTS.md wins on conflict)

1. One commit per task. Message format for phase 0 tasks: `phase0(RC1.4-<id>)`. For other phases use `phase<N>(<id>)`.
2. Failing test FIRST wherever code changes.
3. Secrets scan on `git diff --cached` before every commit (use the exact command in AGENTS.md if it has one; else the one in 1.7).
4. Full hermetic `npm test` before every commit.
5. Every report classifies touched things as REUSED / EXTENDED / CREATED.
6. Use the structured logger, never `console.*`. Never log secrets, tokens, signed URLs or prompts.
7. Do NOT push, tag, merge, rebase published history, or use `--force` or `--no-verify`.
8. Do NOT edit anything under `my-app/` (the frontend). Needed frontend changes go into `docs/release/frontend-changes-needed.md` as exact instructions.

### 1.3 Autonomy rules

- Between TASKS of the same phase do NOT stop and do NOT wait for approval. Finish the task, write the report, update STATE.md, start the next task. Between PHASES: you never continue by yourself; you stop at the end of your phase (see RUN MODE).
- Do NOT ask the human a question that this plan, AGENTS.md or DECISIONS.md already answers.
- Never invent product behavior. When a product choice is open, use the default in section 12 and log that you used it.
- Priority when two goals conflict: (1) security, (2) data integrity, (3) backward compatibility, (4) simplicity, (5) convenience.
- Prefer additive changes: new nullable columns, new tables, new routes. No dropping, renaming, or re-typing of existing columns or tables.
- NEVER rename anything that already exists: tables, columns, classes, files, functions, routes, env vars. This includes the `workflow` table, even though conceptually it is the "Asset" (decision D-21, details in 7.1.2). Renaming is a separate future project.
- Reuse existing patterns first (REUSED > EXTENDED > CREATED). Do not add a new dependency unless there is truly no alternative; if you add one, log it in DECISIONS.md with the reason.
- Fix only what is clearly wrong AND inside the current task. Everything else goes to `docs/plan/BACKLOG.md` (format in 2.8).

### 1.4 Ambiguity decision tree (use it instead of asking the human)

When something is unclear, go down this list and stop at the first step that gives an answer:

1. Does this plan answer it? Use that.
2. Does AGENTS.md answer it? Use that.
3. Does section 12 (default decisions) answer it? Use that.
4. Does the existing code already do something similar (an existing pattern)? Follow the same pattern, even if you would write it differently.
5. Otherwise choose the option that is: safer first, then more reversible, then smaller. Add a new decision line `D-xx` in DECISIONS.md (date, question, options, choice, reason). Continue working.

### 1.5 The ONLY reasons to stop

1. A task still fails after 3 serious attempts (each attempt = you read the error, changed something meaningful, re-ran). Write `docs/plan/escalations/<task-id>.md` (format 2.6), mark the task `BLOCKED` in STATE.md, then continue with tasks that do not depend on it. If every remaining task depends on it, stop.
2. The next step would be destructive or irreversible: dropping data, force push, push, tag, merge, production access, rotating real secrets. Do not do it. Log it, continue.
3. A CRITICAL security problem that you cannot fix safely inside the current task. Write the escalation file marked `CRITICAL`, finish the current task, stop at the next phase gate.
4. The repo contradicts the plan so deeply that the plan's intent cannot be applied (example: SES0 shows neither Path A nor Path B in section 7.3 fits). Escalate and stop THAT phase only.

These are NOT stop reasons: missing secrets, missing network, missing staging access, a command that needs a real DB. For those, mark the check `NOT-RUN`, write the exact command for the human in the report, and continue.

### 1.6 Honesty rules for reports

Tag every factual claim:

- `VERIFIED`: you ran a command or read the code. Add the evidence: a command and a one-line result, or `path/file.js:123`.
- `INFERRED`: you reasoned about it but did not check it.
- `NOT-RUN`: could not be done in this environment. Say why. Give the exact command for the human.

Never write "should work", "probably passes", "looks fine" without a tag. Never write that tests pass unless you ran the FULL hermetic `npm test` in this session and saw it pass.

### 1.7 Cheat sheet of commands (adapt if a command is missing)

Search (use `rg` if installed, else `grep -rn`):
```
rg -n "pattern" src/ lib/ scripts/ tests/            # find usages
rg -n --glob '!node_modules' "x-internal-secret"     # exclude node_modules
rg -n "console\.(log|error|warn|info|debug)" <file>  # find console usage
git ls-files | rg "pattern"                          # find files by name
```
Git:
```
git status --short                 # what changed
git diff                           # unstaged changes
git diff --cached --stat           # staged summary
git diff --cached                  # staged full diff (used for secrets scan)
git log --oneline -n 10            # recent commits
```
Secrets scan (fallback when AGENTS.md gives none). It must print NOTHING:
```
git diff --cached | rg -i "(secret|token|apikey|api_key|password|bearer\s+[a-z0-9]|sk-[a-z0-9]{10,}|eyJ[a-zA-Z0-9_-]{20,}|-----BEGIN)" 
```
If it prints something, look at each hit. A variable NAME like `INTERNAL_SECRET` in code is fine. A real VALUE is not. Replace real values with placeholders such as `<SECRET>`.

Tests:
```
cat package.json | rg -n '"test"|"jest"|"vitest"|"mocha"|"node --test"'   # find the framework
npm test                                                                 # full suite (required before commit)
npx jest path/to/file.test.js        # single file if jest
npx vitest run path/to/file.test.js  # single file if vitest
node --test path/to/file.test.js     # single file if node:test
```
Find the test framework FIRST and write new tests in the same style as existing tests (same imports, same helpers, same folder naming).

### 1.8 Working method (how to avoid typical mistakes)

1. Before you edit a file, read the whole file (or at least the whole function and its imports).
2. Never guess a function signature or a column name. Open the definition. Search the usages.
3. Before you change a function used elsewhere, search all callers (`rg -n "functionName"`) and list them.
4. Keep diffs small. One concern per commit.
5. After every edit, run the relevant test file. Do not wait until the end.
6. If a command fails: read the whole error message. Do not retry the same command blindly. Change something based on the error.
7. If you need a temporary script, put it in `/tmp` or `docs/plan/scratch/` and do NOT commit it (unless the task says so).
8. Write short reports. Do not paste full diffs or huge logs.
9. Leave no `TODO` in code without a matching entry in BACKLOG.md.
10. When you finish, re-read your own diff once as if someone else wrote it.

### 1.9 Anti-patterns (things that are forbidden)

- Editing or deleting an existing test only to make it pass (allowed only if the test is provably wrong; say so explicitly in the report).
- Mocking the exact function you are supposed to test (then the test proves nothing).
- Writing a test that cannot fail (for example asserts `true`, or asserts only that "no error was thrown" while the bug returns a wrong value).
- Claiming a check passed when you did not run it.
- Fixing unrelated things "while you are here".
- Making a security check weaker so a test passes.
- Treating a client-supplied value (header, body, query, params) as trusted.
- Returning 403 for another user's record (always 404).
- Using `console.*`, `process.exit` in library code, or swallowing errors with an empty `catch`.
- Hard-coding limits, secrets, bucket names or URLs that belong in config or env.
- Silent fallbacks that change behavior in production.
- Running several tasks in one commit.
- Renaming existing tables, columns, classes, files or routes "to make them match the product words" (for example `workflow` to `asset`). Forbidden in this plan (D-21).
- Creating a new table, view, alias, repository or service named `asset`/`assets` that duplicates the existing workflow-level entity (D-22).
- Adding denormalized hierarchy columns such as `level`, `depth`, `path`, `root_id`, `ancestor_ids` to folders or assets (D-24).

---

## 2. Task loop, test-writing guide, self-review, templates

### 2.1 The loop (do these steps in this order for EVERY task)

**Step 0: Preflight**
- `git status --short` must be clean (except `docs/plan/`). If not, find out why. Do not mix your work with unknown changes.
- Run `npm test` once. Note the result as the BASELINE. If the baseline is already red, write that in the report and do not blame your change for pre-existing failures; list them.

**Step 1: Read**
- Open `docs/plan/STATE.md`. Open the task card in this file. Open the files named in the card.

**Step 2: Inspect (collect evidence before changing anything)**
- Use the searches given in the card. Write findings in a scratch note: `docs/plan/scratch/<task-id>.md` (not committed) as `file:line: what it does`.
- You need this evidence for the report.

**Step 3: Write the failing test(s)**
- Follow section 2.2.
- Run only the new test file. Confirm it FAILS and that the failure message matches the bug (not a typo or a missing import).

**Step 4: Implement the minimal change**
- Smallest change that makes the tests pass and satisfies the card.

**Step 5: Run tests**
- Run the new test file (must pass), then the full `npm test` (must pass).
- If an unrelated old test fails because of your change: your change is probably wrong or too broad. Fix your change.

**Step 6: Secrets scan**
- Stage with `git add <specific files>` (never `git add -A` blindly).
- Run the scan from 1.7 on `git diff --cached`. It must print nothing.

**Step 7: Self-review**
- Follow section 2.3. Fix findings. Maximum 2 review loops.

**Step 8: Commit**
- One commit, correct message format. Do not push.

**Step 9: Report and state**
- Write `docs/plan/reports/<task-id>.md` (template 2.4).
- Update `docs/plan/STATE.md`.
- Add follow-ups to `docs/plan/BACKLOG.md`.
- Commit the docs together with the code in the same commit if possible; otherwise a tiny `docs(plan)` commit.

**Step 10: Next task** (do not stop).

### 2.2 How to write a good test (for this repo)

1. Find how existing tests are written: open 2 or 3 test files near the code you touch. Copy their structure: imports, setup/teardown, how they build the app or call the middleware, how they mock the database and the logger.
2. Name tests as sentences: `ignores x-internal-secret when INTERNAL_AUTH_ENABLED is not "true"`.
3. Use Arrange / Act / Assert:
   - Arrange: build request, set env, create fake data.
   - Act: call the function or send the HTTP request.
   - Assert: check the exact result (status code, body, whether `next()` was called, whether the DB or credit function was called).
4. Test both sides: the allowed case AND the refused cases (wrong user, wrong project, wrong method, wrong path, flag off, bad input).
5. Environment variables: save the old value, set the new one, and restore it in `afterEach` (otherwise tests affect each other).
6. Do not depend on time, random, network or a real DB. Use fakes/mocks for those only (not for the unit under test).
7. A test must be able to fail. Quick check: temporarily break the code (or revert the fix) and confirm the test goes red, then restore.
8. When asserting "X was NOT called" (example: `hold_credits`), use a spy and assert call count is 0.

Illustration of structure (adapt to the repo's real framework and helpers, do not copy blindly):

```js
describe('internal auth', () => {
  const OLD_ENV = process.env;
  beforeEach(() => { process.env = { ...OLD_ENV, INTERNAL_SECRET: 'test-secret-value' }; });
  afterEach(() => { process.env = OLD_ENV; });

  it('ignores the secret when INTERNAL_AUTH_ENABLED is not "true"', async () => {
    delete process.env.INTERNAL_AUTH_ENABLED;
    const res = await request(app)
      .get('/api/workflows/project-data/abc')
      .set('x-internal-secret', 'test-secret-value')
      .set('x-user-id', USER_ID);
    expect(res.status).toBe(401); // falls through to normal JWT auth, which has no token
  });
});
```

### 2.3 Self-review (this replaces the external reviewer)

After implementing, review your own diff as a hostile reviewer. If your tool supports sub-agents, start a fresh sub-agent that sees ONLY: the diff, the task card, and this rubric. Otherwise do a separate pass and re-read the whole diff from scratch (do not rely on memory of what you meant to write).

For each rubric line write PASS or FAIL plus evidence (file:line or test name). Any open Critical or High blocks the commit.

**Security**

| Sev | Question | How to check |
|---|---|---|
| Critical | Is any identity (user id, role, project id) taken from a client-controlled header/body/query and trusted without server-side proof? | Search the diff for `req.headers`, `req.body.userId`, `x-user-id`. A shared secret + client-supplied user id = impersonation key. |
| Critical | Every id received from the client (project, folder, asset, element, workflow): is it verified to belong to the current user AND to the same project as the other ids in the request? | For each id in the diff, find the line that loads it with a user/project-scoped query. If none, FAIL. |
| High | Cross-tenant access returns 404 and never 403? | Search the diff for `403`, `Forbidden`. |
| High | Is any allow-list as narrow as the REAL callers need? | Compare the list to the real callers you found by grep (file:line). Prefix matches are suspicious. |
| High | Can something that spends credits or money be reached through a weaker auth path? | Trace generation and billing routes to their auth middleware. |
| High | Is validation done BEFORE spending credits or accepting expensive work? | Look at order of calls: validate, then `hold_credits`. |
| Medium | Secrets, prompts, tokens, signed URLs in logs, reports, test data, docs? | Read every logger call in the diff. Run the secrets scan. |
| Medium | Any fail-open behavior (error leads to weaker security or to in-memory storage outside `NODE_ENV=test`)? | Read every `catch`. What happens on error? |

**Correctness and data**

| Sev | Question | How to check |
|---|---|---|
| High | Money/credits are integers (minor units) or a consistent exact decimal type, never float arithmetic? | Search for `parseFloat`, `toFixed`, `Math.round`, `* 0.`, `/ 100` near credits. |
| High | Failure handlers and retries are idempotent? | Read the handler: what happens if it runs twice with the same job id? Is there a test? |
| Medium | No magic numbers: limits come from config/env and are documented? | Search the diff for numeric literals. |
| Medium | Migrations are additive and have rollback notes? | Read the SQL for `drop`, `rename`, `alter ... type`, `not null` on existing columns. |

**Operability**

| Sev | Question | How to check |
|---|---|---|
| Medium | `/health` (liveness) and `/ready` (readiness) differ; `/ready` is 503 when a dependency is down; no internals for anonymous callers? | Read the handlers and tests. |
| Medium | Structured logger only. No `console.*` in touched files? | `rg -n "console\." <touched files>` prints nothing. |
| Low | Docs updated; no placeholder values left that the human cannot resolve? | Read the doc diff. |

**Tests**

| Sev | Question | How to check |
|---|---|---|
| High | The new test failed before the fix? Negative tests exist (wrong user, wrong project, wrong method, flag off)? | Say which output showed the failure. |
| High | Tests are hermetic (no network, no `.env`, no real DB)? | Run `npm test` with network off if possible; read the imports. |
| Medium | Tests check behavior (results), not implementation details? | Would the test still pass after a harmless refactor? |

**Report honesty**

| Sev | Question | How to check |
|---|---|---|
| High | Every claim in the report is tagged VERIFIED / INFERRED / NOT-RUN? | Re-read the report. |

Scoring: start at 100. Critical = -40, High = -15, Medium = -5, Low = -2. To commit you need score >= 85 AND no open Critical or High. Put the score and the list of findings (including fixed ones) in the report.

### 2.4 Report template (`docs/plan/reports/<task-id>.md`)

```
# <task-id>: <title>
Status: DONE | DONE-WITH-FOLLOWUPS | BLOCKED
Commit: <sha> (not pushed)
Self-review score: NN/100 (loops: N)
Baseline `npm test` before: PASS|FAIL (N tests)   After: PASS (N tests)

## What changed (REUSED / EXTENDED / CREATED)
- EXTENDED  src/middleware/auth.js  (added allow-list + flag)
- CREATED   tests/auth.internal.test.js
- REUSED    logger (src/lib/logger.js)

## Evidence (tag each: VERIFIED / INFERRED / NOT-RUN)
- VERIFIED: only caller of x-internal-secret is ElementVisionService (my-app/src/...:45); backend grep: 0 callers
- NOT-RUN: curl on staging (needs real URL). Command for the human: ...

## Tests
- New tests: (list names)
- Failing-first confirmed: yes, output: "Expected 401, received 200"
- Full npm test: PASS (N tests)

## Decisions taken (refs to DECISIONS.md)
## Follow-ups (also copied to BACKLOG.md)
## Manual checks for the human (exact commands)
```

Good vs bad evidence line:
- GOOD: `VERIFIED: rg -n "x-internal-secret" src/ => 1 hit, src/middleware/auth.js:58 (the reader, not a caller)`
- BAD: `It seems that only the frontend uses the secret.`

### 2.5 STATE.md format

```
# STATE
Current phase: P<n>    Current task: <id>
Updated: <date>

| Task | Status (TODO/DONE/BLOCKED/SKIPPED) | Commit | Report |
|---|---|---|---|
| SETUP-1 | TODO | | |
```

### 2.6 Escalation file format (`docs/plan/escalations/<task-id>.md`)

Write it so the human can paste it into a chat assistant in ONE message:

```
Task: <id>    Severity: CRITICAL | BLOCKER
Goal of the task (1 line):
What I tried (3 attempts, 1 line each):
Exact error or failing test output (only the relevant lines):
Relevant code (file:line, max 10 lines each):
Why I cannot decide alone:
The 2 options I see + my recommendation:
```

### 2.7 DECISIONS.md line format

```
D-15 | 2026-10-07 | Question: ... | Options: A ..., B ... | Chosen: A | Reason: safer and reversible
```

### 2.8 BACKLOG.md line format

```
- [Severity] path/file.js:123 | what is wrong in one line | found during <task-id>
```

### 2.9 Failure and rollback

- If your change breaks unrelated tests: revert your change in that file (`git checkout -- <file>` for UNSTAGED, uncommitted edits of your own only) and approach again. Do not edit unrelated tests.
- If a migration cannot be written additively: stop that task (reason 1.5.2).
- Never rewrite or squash commits that already exist before you started.

---

## 9. Appendix: checklists

### 9.1 Pre-commit checklist (run mentally before EVERY commit)

- [ ] I wrote the failing test first and saw it fail for the right reason.
- [ ] The new tests pass; the FULL hermetic `npm test` passes.
- [ ] `git diff --cached --stat` shows only files that belong to this task.
- [ ] Secrets scan on `git diff --cached` printed nothing.
- [ ] `rg -n "console\." <touched src files>` prints nothing.
- [ ] No identity or id from the client is trusted without a scoped check.
- [ ] Cross-tenant cases answer 404.
- [ ] No hard-coded limits, bucket names, URLs or secrets.
- [ ] I did not edit `my-app/`. I did not push, tag or merge.
- [ ] The self-review score is >= 85 with no open Critical or High.
- [ ] The report exists, every claim is tagged, STATE.md is updated.

### 9.2 Migration file checklist

- [ ] Only adds (tables, nullable columns, indexes, constraints). No drop, rename, retype, or NOT NULL on existing data. The existing table names are unchanged (D-21).
- [ ] Safe to run twice (`if not exists`, or a guarded block for constraints).
- [ ] Constraint and index names are explicit and follow the repo style.
- [ ] Rollback steps are written as comments at the top.
- [ ] Not applied to any real database by you. The human applies it (command given in the report).

### 9.3 Route checklist (every new or changed route)

- [ ] Authentication middleware is the normal JWT one; the route is NOT reachable through the internal-secret path.
- [ ] `assertOwns("project")` (or the scoped lookup) runs before anything else touches ids.
- [ ] Input validated (types, lengths, allowed values) using the repo's validation approach.
- [ ] Response contains only the caller's data.
- [ ] Errors use the repo's error class and the codes in 7.5.
- [ ] Rate limiter applied on write routes.
- [ ] Tests: success, 401, 404 for foreign ids, validation error.

---

## 10. Phase gates (do these at the end of EVERY phase, without asking the human)

At the end of EACH phase, before starting the next:

1. Full hermetic `npm test` is green.
2. `git status --short` shows nothing uncommitted except `docs/plan/scratch/`. Nothing was pushed.
3. STATE.md is updated; every task in the phase has a report (or a SKIPPED/BLOCKED note with its escalation file).
4. Cross-checks (fix tiny things inside the phase scope; put everything else in BACKLOG.md):
   - `rg -n "console\." <files changed in this phase>` prints nothing.
   - No new unscoped repository call was introduced (`rg -n "deleteById|findById" <files changed>` and read each hit).
   - Every new environment variable is documented with name, default and who must set it.
5. Write `docs/plan/reports/PHASE-<n>-GATE.md`: max 10 lines of summary, open follow-ups, manual checks for the human.
6. Run the phase acceptance test written at the END of the phase file you just finished and paste its results in the gate report.
7. Set `Next step: <what the human should do next> (waiting for the human)` in STATE.md, print the summary (max 15 lines) and STOP. Do not start the next phase.

---

## 12. DECISIONS.md seed (use these defaults, do not ask)

| ID | Decision | Default |
|---|---|---|
| D-01 | Folder structure | One `folders` table with `parent_id`; a sub-folder is a normal folder |
| D-02 | Asset to folder relation | One folder per asset (`folder_id` column), no join table in v1 |
| D-03 | "All assets" | A view/query, never a row |
| D-04 | Generation outside a project (reference "My generations") | OPEN PRODUCT QUESTION. v1 requires a project. Schema does not block a nullable `project_id` later. The owner will test the reference app and decide |
| D-05 | Element import across projects | Copy (not reference) in v1 |
| D-06 | Folder delete | Blocked unless empty (409 `FOLDER_NOT_EMPTY`); assets are never deleted silently |
| D-07 | Folder listing default | Direct children only; `includeDescendants=true` is opt-in; "All assets" shows everything |
| D-08 | Cross-tenant response | 404, never 403 |
| D-09 | Credits arithmetic | Integer minor units preferred; no wallet redesign inside D3, only fix proven bugs |
| D-10 | Health endpoints | `/health` liveness (always 200), `/ready` readiness (503 if Redis not ready) |
| D-11 | Internal-secret auth | Off unless `INTERNAL_AUTH_ENABLED=true`; exact method+path pairs of real callers only |
| D-12 | Folder limits | Config `FOLDER_MAX_DEPTH`=5, `FOLDER_MAX_PER_PROJECT`=500, `ASSET_LIST_MAX_LIMIT`=200 |
| D-13 | Unknown audit scopes (GEN1, NAM0, DM1) | Skip with an escalation note; never guess |
| D-14 | Spec Kit unavailable | Continue using this file's task cards as the spec |
| D-15 | Folder names | Unique among siblings (case-insensitive); same name allowed under different parents |
| D-16 | Moving an asset | Dedicated route `PATCH /api/assets/:assetId/folder`; the generic update route must not accept `folderId`, `projectId`, `userId` |
| D-17 | Migration of asset `user_id` | Add nullable, backfill in a separate step, enforce NOT NULL in a later migration (not in this plan) |
| D-18 | Folder FK delete rule | `NO ACTION` (default), not `RESTRICT`, so project cascade deletes work |
| D-19 | Concurrent folder moves | Accept the rare race in v1; BACKLOG item to add a transaction with row locks |
| D-20 | Legacy listing endpoints | Keep their response shapes unchanged; new filtered/paginated listing is separate or backward compatible |
| D-21 | Naming of existing things | NO renames of tables, columns, classes, files, routes or env vars. `workflow` stays `workflow` even though it is the "Asset" in product terms. Rename later as a separate project (BACKLOG `RENAME-LATER`) |
| D-22 | Asset-level code | Extend the EXISTING repository/service of the asset-level table. No new `AssetRepository`, `AssetService`, `assets` table or view |
| D-23 | Public API vocabulary | New public endpoints and JSON use product words (`assets`, `folders`, `folderId`). One serializer maps the real row to the asset JSON. Existing routes unchanged |
| D-24 | Hierarchy storage | Only direct relations (`parent_id`, `folder_id`). No `level`, `depth`, `path`, `root_id`, `ancestor_ids` columns |
| D-25 | Same-project rule | Enforced twice: composite foreign keys in the DB AND checks in the service. Depth check on move includes the height of the moved sub-tree |

Add new decisions as `D-26`, `D-27`, ... using the line format in 2.7. Never deviate silently.
