# 05_SPEC_KIT_GUIDE: how to use Spec Kit with the phase files

> Used only when the prompt says `SPEC_KIT = ON`, and never in phase P2. The installation steps (SETUP-2) are in `01_P0_setup_and_D2.6.md`.

### 3.1 Spec Kit workflow per phase

**Principles**
- Spec Kit prepares and splits the work. The plan files decide what is right. Spec Kit output NEVER overrides `00_CORE.md` sections 1 and 2 (rules, loop, rubric, commit format).
- One Spec Kit feature per phase: P0 -> `p0-hardening`, P1 -> `p1-verifications`, P3 -> `p3-folders`. P2 (audits) does not use Spec Kit. Spec Kit adds a number prefix automatically after the existing features (for example `034-p0-hardening`): keep the number it gives, never renumber, and never touch existing feature folders (for example `specs/033-...`). The pointer line in AGENTS.md to another feature's plan is background only; if Spec Kit rewrites it to point to your new feature, leave it.
- Prepare ONLY the phase you were given, at the START of its session (the human gave you its file). Never prepare other phases in advance, because results of earlier phases change later phases (SES0 decides Path A or B and produces `NAMING_MAP.md` before P3), early specs become stale, and a bigger context makes you less reliable.
- Spec Kit files live in `specs/` and `.specify/`. Plan files stay in `docs/plan/`. Do not mix them.
- Branches: stay on the branch you started on. If a Spec Kit script creates or switches to a feature branch, switch back, set the feature directory manually if needed, and log it in DECISIONS.md. Do not merge branches (the human merges).

**Which Spec Kit commands to use:** `specify`, `clarify`, `plan`, `tasks`, `analyze` (the planning commands, used in PREP). NOT `implement` (see IMPLEMENT below). Command names depend on the installed version (`/speckit.specify` or skill names): use the real names recorded in DECISIONS.md.

**How to run a Spec Kit command yourself (read this before PREP):**
1. Find the real command names. If `docs/plan/DECISIONS.md` has no line with them (for example SETUP-2 was skipped), discover them now: list the command folder of your agent (`.gemini/commands/`, `.claude/commands/`, or the folder created by Spec Kit) and `ls .specify/` , then write the names in DECISIONS.md.
2. Slash commands are normally typed by the human in the chat. If your tool lets you invoke them, do so. If you CANNOT invoke a slash command yourself, open its command file in the command folder and follow the instructions inside it step by step as if they were your prompt (it is a prompt template). The result must be the same: files created under `specs/<NNN>-<feature>/` (`spec.md`, `plan.md`, `tasks.md`, ...). Use the helper scripts in `.specify/scripts/` only if the command file tells you to.
3. If after 3 attempts a command cannot be run or produces nothing usable, apply "If Spec Kit misbehaves" below (set `SPEC_KIT = OFF`, continue with the task cards). Tell the human in the summary which command failed; the human can then type the commands manually in the chat.

**PREP-<phase> (no implementation, no code changes)**
1. `specify`: paste the phase file you were given VERBATIM (P0: `01_P0_setup_and_D2.6.md` section 4; P1: `02_P1_D3_verifications.md`; P3: `04_P3_folders.md` sections 7.1 to 7.7), plus the decisions table of `00_CORE.md` section 12. Do not summarize.
2. `clarify`: answer every question from this file and DECISIONS.md. Ask the human only if the answer is truly missing; otherwise write the assumption in DECISIONS.md.
3. `plan`: give these constraints: "Use the existing stack and patterns. No new dependencies. Additive migrations only. Failing test first. Hermetic tests. Follow the repo's route, validation and error conventions."
4. `tasks`: generate the task list, then COMPARE `tasks.md` with the task cards of the phase file:
   - one-to-one mapping (P0: D2.6 a to e; P1: D3 1 to 5; P3: F-T1 to F-T9);
   - every code task has a "write failing test" step BEFORE the implementation step;
   - the security tests listed in the card tables are present;
   - one commit per task;
   - nothing extra: no new dependency, no unrelated refactor, nothing under `my-app/`.
   If `tasks.md` differs, edit it to match the phase file (the phase file wins) and note the differences in the PREP report.
5. `analyze`: run it. Fix inconsistencies in the Spec Kit files, never in the plan files.
6. Write `docs/plan/reports/PREP-<phase>.md`: feature directory, list of task ids, differences found, open assumptions. Set STATE.md `Next step: IMPLEMENT-<phase> (waiting for GO from the human)`. Print a summary (max 15 lines). STOP. The human reads `tasks.md` and writes `GO`.

**IMPLEMENT-<phase> (after GO)**
- Execute the tasks of `tasks.md` in order, BY HAND, one task at a time. Do NOT use the Spec Kit `implement` command unless the human explicitly asks for it: it runs the whole list in one go and tends to batch tasks, skip the failing-test-first step and skip the self-review, which breaks the loop of `00_CORE.md` section 2.1. EVERY task follows the loop in section 2.1 (failing test first, full hermetic `npm test`, secrets scan, self-review, ONE commit, report, STATE.md).
- If Spec Kit's implement tries to batch several tasks into one commit, or to skip the failing-test-first step, do not follow it: follow section 2.1.
- At the end: phase gate (`00_CORE.md` section 10) and the acceptance test at the end of the phase file, then STOP.

**If Spec Kit misbehaves** (wrong files, overwrites, long loops, 3 failed attempts): set `SPEC_KIT = OFF` for the rest of the plan, log it as a decision, and continue with the task cards of the phase file. Not a stop reason.
