# Phase P2: read-only audits

> Read `00_CORE.md` completely BEFORE this file (rules, loop, rubric, decisions). Section numbers are those of the original plan; the index in `00_CORE.md` says where each section lives.
> Scope of THIS file: section 6 (SES0, GEN1, NAM0, DM1). Do not read or start other phase files.
> Prerequisites: Phase P1 is DONE (check `docs/plan/STATE.md`). If not, STOP and say so.

## Order of work in this session

1. This phase NEVER uses Spec Kit.
2. Audits SES0, GEN1, NAM0, DM1 in this order. All strictly read-only.
3. SES0 must also produce `docs/plan/NAMING_MAP.md`.
4. Phase gate, acceptance test, STOP.

---

## 6. Phase P2: read-only audits

Rules for ALL audits:
- STRICTLY read-only. No code change, no migration, no test change.
- The only thing you write is the audit report: `docs/plan/reports/<AUDIT-ID>.md`. Commit only that file (and STATE.md): `phase2(<AUDIT-ID>)`.
- Evidence format: `path/file.js:123` plus a one-line statement. Tag VERIFIED / INFERRED / NOT-RUN.
- Do not "fix as you go". Findings go into BACKLOG.md.
- Audit report structure: (1) scope in your own words, (2) method (commands run), (3) findings table, (4) answers to the questions, (5) verdict/conclusion, (6) risks, (7) what you could not verify.

### SES0: assets and folders model audit (scope known)

**Purpose.** Before changing the database for folders, find out what exists today and whether the target model in section 7 fits on top of it without breaking anything.

**Step 1: map the data model.** Find the migrations and the table definitions:
```
git ls-files | rg -i "migration|schema|\.sql$"
rg -n "create table|alter table" <migrations folder>
```
For these concepts, find the real table/column names: projects, workflows (or runs), media, characters, elements, users, credits/wallet. Write a small table: concept -> table -> columns (name + type + nullable) -> foreign keys.

**Step 2: test the central hypothesis.** The hypothesis (from earlier discussion, NOT verified): "a `workflow` row = an asset; a `media` row = a version of that asset; the 'primary media' (`updatePrimaryMedia`) = the current version". To check it:
- Open the workflow repository/service and the media repository/service. List their methods. Look at `updatePrimaryMedia`, `findByProject` and similar.
- Answer each of these with evidence:
  a. Is one workflow row created for each generation/upload that a user sees as an "item"?
  b. Do media rows reference a workflow id (a foreign key)? Can one workflow have several media rows? Is one of them marked primary?
  c. When the user re-generates or edits, is a NEW media row added to the same workflow (version-like), or a NEW workflow row?
  d. Which table does the "list items of a project" query use?
  e. Do both tables carry `user_id` and `project_id`? Which of these are nullable?
- Verdict rule: CONFIRMED if a, b, c, d all point to workflow as the user-visible item and media as its files/versions. REFUTED if the user-visible item is another table. PARTIAL otherwise (explain).

**Step 3: other questions (answer all)**
1. Is there any existing folder/collection/grouping (table, column, route, UI field)? `rg -n -i "folder|collection|group|album" src/ lib/ migrations/`
2. Which routes list a project's items today? Pagination and filters? `rg -n "findByProject|project-data|/projects/" src/routes src/controllers`
3. What do generate and upload requests accept today (`projectId`? others)? Is `projectId` required? Is there any generation without a project?
4. Characters and Elements: they are two separate services today. List tables, routes and how their images are linked (to media rows or raw URLs).
5. Migration tooling: where do migrations live, naming scheme, how they are applied, which DB engine, whether Row Level Security (RLS) policies are used.
6. How does `assertOwns("project")` work (which query, what it returns on failure)?
7. Project deletion: what happens to workflows/media when a project is deleted (cascade, soft delete, manual)? This matters for new foreign keys.
8. Where do the validations "same project" exist today?

**Step 4: conclusion (mandatory)**
State clearly: "Path A applies" or "Path B applies" (definitions in section 7.3), with the evidence list that led you there. Also list:
- the exact table that will receive `folder_id`;
- whether `user_id` exists directly on that table;
- whether `project_id` is nullable there;
- the migration folder and naming scheme to follow;
- any existing constraint or index that conflicts;
- the NAMING MAP (template in 7.1.2) filled with the REAL names found in the repo. Save it as `docs/plan/NAMING_MAP.md`. Every later task reads it. If you cannot fill a cell, write `UNKNOWN` and say what you searched.

### GEN1, NAM0, DM1: scope NOT available to the planner

The person who wrote this plan does not have the scope of these three audits. Do NOT guess what they mean from their names.

HUMAN FILL-IN (the owner pastes the original scope of each audit here):
```
GEN1 scope: <paste here>
NAM0 scope: <paste here>
DM1  scope: <paste here>
```

Procedure for each of the three:
1. If the block above is filled, use it as the scope and follow the audit rules at the top of this section.
2. Otherwise search the repo for an original definition: `rg -n "GEN1" docs/ AGENTS.md README.md` (same for NAM0 and DM1). If found, use it.
3. If still not found: do NOT invent a scope. Write `docs/plan/escalations/<ID>-scope.md` with one line "scope missing", mark the task `SKIPPED` in STATE.md, and continue with the next audit. This is not a stop reason.

### P2 acceptance
Each audit has its report (or a SKIPPED note with an escalation file). Nothing but docs changed (`git diff --stat` for the phase shows only `docs/plan/`). Then phase gate (section 10).

---

## Phase end: gate and acceptance test

1. When every task above is DONE, BLOCKED or SKIPPED, run the phase gate (`00_CORE.md` section 10).
2. Phase acceptance test. Run each check and paste the results (command or test name + result, tagged VERIFIED / NOT-RUN) into `docs/plan/reports/PHASE-P2-GATE.md`:

Always: full hermetic `npm test` passes; `git status --short` clean (except `docs/plan/scratch/`); nothing pushed; every task of the phase has a report with tagged claims.

| Phase | Extra checks |
|---|---|
| P2 | (1) A report for each of SES0, GEN1, NAM0, DM1, or a SKIPPED note with its escalation file. (2) `git diff --stat <phase start>..HEAD` shows only files under `docs/plan/`. (3) `docs/plan/NAMING_MAP.md` exists with real names and no `UNKNOWN` cell that blocks P3. (4) SES0 report states Path A or Path B with evidence. |

If any check fails: fix it inside the phase (same loop), re-run the phase acceptance test, then report. Do not stop with a failed check unless a stop reason of 1.5 applies.

3. Write the gate report, update STATE.md with `Next step: P3 (human gives you `04_P3_folders.md` in a new session; the human must first read the SES0 report and NAMING_MAP.md)`, print a summary (max 15 lines) and STOP.
