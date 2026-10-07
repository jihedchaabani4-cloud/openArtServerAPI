# HUMAN GUIDE (for you, the owner; the agent does not need this file)

## 1. Where to put the files

Copy all files into the backend repo under `docs/plan/` (same folder):

```
docs/plan/00_CORE.md
docs/plan/01_P0_setup_and_D2.6.md
docs/plan/02_P1_D3_verifications.md
docs/plan/03_P2_audits.md
docs/plan/04_P3_folders.md
docs/plan/05_SPEC_KIT_GUIDE.md
docs/plan/06_FINAL_AND_P4.md
```

Make sure you are in the BACKEND repo (the one with `auth.js`, `RunRepository`, `npm test`). If you use Gemini CLI, add one line in `GEMINI.md`: `Read AGENTS.md first.` (it reads GEMINI.md, not AGENTS.md).

**AGENTS.md:** if Spec Kit already wrote a line in it (for example `read the current plan at specs/033-.../plan.md`), DO NOT edit or delete that line or the Spec Kit markers. Open the "Raw" tab and add the block below ABOVE them (the agent also checks this in SETUP-1 and adds it if missing):

```
## Project rules
- Before any task, read docs/plan/00_CORE.md and the phase file the human names. The plan files win over any Spec Kit file.
- One commit per task. Failing test first. Full hermetic `npm test` before every commit (no .env, no network, no real DB).
- Secrets scan on `git diff --cached` before every commit.
- Use the structured logger, never console.*. Never log secrets, tokens or prompts.
- Never push, tag, merge, or edit anything under my-app/.
- Every id from a client must be ownership-checked and project-scoped. Cross-tenant access returns 404, never 403.
- Additive migrations only. Never rename existing tables, columns, classes or routes.
```

## 2. The order (one phase = one file = one new session)

| Step | Phase file you give the agent | Needs before | Spec Kit |
|---|---|---|---|
| 1 | `01_P0_setup_and_D2.6.md` | nothing | optional (ON or OFF) |
| 2 | `02_P1_D3_verifications.md` | step 1 done and checked | optional |
| 3 | `03_P2_audits.md` | step 2 done. FIRST paste the scopes of GEN1, NAM0, DM1 into the file (section 6), or the agent skips them | never |
| 4 | `04_P3_folders.md` | step 3 done: `docs/plan/NAMING_MAP.md` exists and you read the SES0 verdict (Path A or B) | recommended |
| 5 | `06_FINAL_AND_P4.md` | step 4 done | never |

Always `00_CORE.md` is read together with the phase file. The agent does this itself (the prompt tells it to).

## 3. The prompt to paste for each phase

Replace `<PHASE_FILE>` with the file name from the table and choose `SPEC_KIT = OFF` or `ON`.

```
Read AGENTS.md first. Then read docs/plan/00_CORE.md completely, then docs/plan/<PHASE_FILE> completely.
Do NOT open any other phase file (the only exception: docs/plan/05_SPEC_KIT_GUIDE.md when SPEC_KIT = ON). RUN_MODE = PHASE_STOP. SPEC_KIT = OFF.
Spec Kit is already installed in this repo: never run `specify init`. The line in AGENTS.md that points to
specs/033-prompt-bar-platform/plan.md is background context only, it is NOT your task; never modify it.
Execute the phase described in that file, following its "Order of work", the loop in 00_CORE.md
section 2.1 for every task (failing test first, full hermetic npm test, secrets scan,
self-review with the rubric in 2.3, one commit, report, update STATE.md).
At the end run the phase gate (00_CORE.md section 10) and the acceptance test written at the end
of the phase file, write the gate report, print a summary of at most 15 lines, and STOP.
Stop earlier only for the reasons in 00_CORE.md section 1.5.
Do NOT push, tag, merge, or edit anything under my-app/.
```

With Spec Kit: replace `SPEC_KIT = OFF` by `SPEC_KIT = ON`. The agent then does PREP first (spec, plan, tasks, analyze), writes `docs/plan/reports/PREP-<phase>.md` and STOPS. You read `specs/.../tasks.md` and the PREP report, then send `GO` (see section 5).

## 4. Between phases: 5-minute checks

Do these yourself on the repo, do not trust only the agent's report:

1. `git log --oneline`: one commit per task, correct message format.
2. `git status --short`: clean.
3. `npm test` on your machine: green.
4. Open the gate report and the task reports: claims are tagged VERIFIED / NOT-RUN, no "should work".
5. `rg -n "console\." <files the phase touched>` prints nothing; new migrations contain no `drop` or `rename`.

Two stops deserve more attention:
- After P0 (`D2.6`, security): send me the report (or the diff of `auth.js` and its tests) for a review before step 2.
- After P2 (`SES0`): read `docs/plan/NAMING_MAP.md` and the Path A or B verdict before step 4. If it says Path B, bring me the report first: the migration changes.

## 5. Other prompts

**GO (after a PREP stop, same session):**
```
GO. Implement the tasks of tasks.md for this phase, following the loop in 00_CORE.md section 2.1
for each task (Spec Kit never overrides the plan). At the end run the phase gate and the acceptance
test of the phase file, print a summary (max 15 lines) and STOP.
```

**FIX (something was wrong in the last phase):**
```
FIX: <what is wrong>. Fix it inside the same phase with the same loop (failing test first),
re-run the phase acceptance test, update the gate report, print a summary and STOP.
```

**RESUME (new session, lost context, or interrupted):**
```
Read AGENTS.md, docs/plan/00_CORE.md completely, docs/plan/<PHASE_FILE> completely, then docs/plan/STATE.md.
Spec Kit is already installed: never run `specify init`; the pointer to specs/033-.../plan.md in AGENTS.md is background only.
Run git status --short and the full hermetic npm test. Continue from the first task of this phase that is
not DONE. If a task was half done (uncommitted changes), inspect the diff first, decide whether to finish
or discard your own earlier edits, and log it. RUN_MODE = PHASE_STOP, same rules, same stop at the end.
```

**AFTER YOU FIXED A BLOCKED TASK:**
```
Read docs/plan/escalations/<id>.md and my notes below. Re-run task <id> from step 3 of the loop
(failing test first), then continue with the remaining tasks of the phase and stop at the end.
My notes: <paste notes>
```

If the agent is blocked it writes `docs/plan/escalations/<task>.md`. Paste that file to me in one message.

## 6. Tips

- Use a NEW session for each phase. `STATE.md` keeps the position, nothing is lost.
- Thinking level: medium or high for the security phases (P0 and P3).
- If the agent starts skipping steps (no failing test, no report), stop it, open a fresh session and use RESUME.
- Do not apply the migrations yourself blindly: read them, apply on staging first.

## 7. Your checklist (only you can do these)

1. Paste the scopes of GEN1, NAM0, DM1 in `03_P2_audits.md` (section 6), or confirm they are in the repo docs.
2. Test the two open questions in the reference app and update decision D-04 in `docs/plan/DECISIONS.md` if needed: (a) moving an image to another folder removes it from the first? (b) generating from Home without a project: does it appear only in "My generations"?
3. Rotate `INTERNAL_SECRET`. Never put it in a frontend env.
4. Ship the `ElementVisionService` change (use the user's JWT, no secret) BEFORE or WITH the D2.6 backend release.
5. Run the `NOT-RUN` checks on staging: stored-file curl, `/ready` behind the load balancer, load test for the upload cap, applying the migrations.
6. Apply the migrations yourself (the agent never touches a real database) and verify the backfill count if a `user_id` backfill was needed.
7. Unlock phase P4 items (F3, F4, F5, F7) in writing when you want them started.
8. Decide later when to do the `workflow` to `asset` rename (BACKLOG `RENAME-LATER`). It needs its own plan; do it only after P3 is finished and stable.
