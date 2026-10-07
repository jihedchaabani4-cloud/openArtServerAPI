# 06_FINAL_AND_P4: locked phase and final summary

> Read `00_CORE.md` completely BEFORE this file. Use this file only when the human gives it to you, AFTER the P3 gate passed.
> Prerequisites: phases P0, P1, P2, P3 are DONE in `docs/plan/STATE.md`.

## 8. Phase P4: F3, F4, F5, F7 (LOCKED)

The author of this plan has NO scope for these four items. Do NOT start them, in any form (no reading to "prepare", no scaffolding, no tests), until the human unlocks them in writing (a message such as "unlock F3"). When you reach this point, write the final summary (section 11) and stop.

---

## 11. Final summary (when everything reachable is done)

Write `docs/plan/FINAL.md`:

1. Table of all tasks: id, status, commit, self-review score.
2. All `NOT-RUN` items collected as ONE checklist with the exact commands for the human.
3. All BACKLOG items sorted by severity.
4. Open escalations (with the file names).
5. Environment variables added or changed: name, default, who must set it.
6. Deploy order, plus the frontend changes required (link to `docs/release/frontend-changes-needed.md`).
7. The statement: "Phase P4 (F3, F4, F5, F7) was not started because it is locked."

After writing `docs/plan/FINAL.md`, commit it (`phase5(FINAL)`), update STATE.md and STOP.
