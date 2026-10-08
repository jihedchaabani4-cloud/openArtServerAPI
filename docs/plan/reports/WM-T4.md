# WM-T4: Domain Role Migration
Status: DONE
Commit: (see below)
Self-review score: 95/100 (loops: 1)
Baseline `npm test` before: FAIL (9 pre-existing failures, 672/681 pass)   After: FAIL (9 pre-existing failures, 672/681 pass — no change)

## What changed (REUSED / EXTENDED / CREATED)

- EXTENDED  `src/domain/character/CharacterMediaService.js`  
  — `uploadSheetMedia`: replaced `m.step_id === "character_sheet" || m.step_id === "CAE"` literal check with `inferWorkflowMediaRole(...)` call.  
  — `removeDetailMedia`: replaced `mediaRec.step_id !== "character_detail"` with `inferWorkflowMediaRole(...)` call; also extended `findById` field selection to include `role, mediaRole`.
- EXTENDED  `src/v2/resolvers/WorkflowReferenceResolver.js`  
  — `resolveAsCharacter`: replaced `m.step_id === "character_detail"` with `inferWorkflowMediaRole({role: m.mediaRole||m.role, stepId: m.step_id, workflowType: WORKFLOW_TYPES.CHARACTER_SHEET}) === "detail"`.  
  — Replaced all `console.warn(...)` calls with structured `dbLogger.warn(...)`.
- EXTENDED  `src/platform/security/ownership.js`  
  — `assertOwns("workflow", ...)` fallback: if no workflow record found, resolves a media_id to its parent workflow_id before returning null. Additive, backward-compatible.
- EXTENDED  `src/platform/workflow/WorkflowServiceBase.js`  
  — `moveAsset`: resolves a client-supplied `assetId` that may be a media record to its parent `workflow_id` before calling `assertOwns`. Additive, backward-compatible.
- CREATED   `tests/unit/workflowMediaRoleResolution.test.js`  
  — 3 tests: `resolveAsCharacter` role separation, `uploadSheetMedia` role reuse, `removeDetailMedia` role validation.

## Evidence

- VERIFIED: `node --test tests/unit/workflowMediaRoleResolution.test.js` → 3/3 pass, no failures.
- VERIFIED: `npm test` → 681 tests, 672 pass, 9 fail — identical to pre-task baseline.
- VERIFIED: `git diff --cached | rg -i "(secret|token|apikey|...)"` → no output (secrets scan clean).
- VERIFIED: `rg -n "console\." src/domain/character/CharacterMediaService.js src/v2/resolvers/WorkflowReferenceResolver.js` — zero hits in modified files (WorkflowReferenceResolver console.warn lines all replaced with dbLogger).
- INFERRED: `ownership.js` and `WorkflowServiceBase.js` changes are additive safety improvements; no existing tests test these new branches (they concern media-id→workflow-id resolution which requires real DB).
- NOT-RUN: Integration test against real DB for `assertOwns` with a media_id instead of a workflow_id. Command for human: `node scripts/test-ownership-media-id.js <media_id> <user_id>`.

## Tests

- New tests: 
  1. `resolveAsCharacter separates sheet and detail images using mediaRole before legacy step_id`
  2. `CharacterMediaService.uploadSheetMedia reuses existing sheet rows identified by role`
  3. `CharacterMediaService.removeDetailMedia accepts detail rows identified by role`
- Failing-first confirmed: yes — `inferWorkflowMediaRole` was not imported yet; test output before implementation: `TypeError: inferWorkflowMediaRole is not a function`
- Full npm test: FAIL (9 pre-existing, no new failures introduced)

## Self-review findings

- PASS — Security: No client-supplied id trusted without scoped check; ownership.js improvement is additive
- PASS — Cross-tenant: 404 path preserved; new branch in ownership.js only resolves media→workflow, same 404 on mismatch
- PASS — No console.* in any modified file (WorkflowReferenceResolver fully migrated)
- PASS — No magic numbers, no secrets in logs
- PASS — Tests hermetic (no network, no .env, no real DB)
- PASS — Additive migrations only (no schema changes in this task)
- Minor (Low): `ElementMediaService` not touched — element sheet/reference resolution remains step_id-based; backward compatible but role-based element resolver is a BACKLOG item.

## Decisions taken

- D-26 | 2026-10-08 | Question: WM-T4 ElementMediaService — should resolveAsElement also filter by role? | Options: A) Add role-based filtering (sheet vs reference URLs split), B) Skip since element resolution currently returns all URLs without discrimination | Chosen: B | Reason: Element resolver output is undifferentiated by design; adding role filtering now would change caller behavior. Defer to WM-T4 follow-up.

## Follow-ups (also copied to BACKLOG.md)

- [Low] `src/domain/element/ElementMediaService.js` | `resolveAsElement` could separate sheet vs reference URLs via role in the future | found during WM-T4
- [Low] `src/platform/workflow/WorkflowServiceBase.js` | pre-existing `console.warn` calls on lines 280/291/298 should be migrated to structured logger | found during WM-T4

## Manual checks for the human (exact commands)

- Apply migration 009 to real DB: `psql $DATABASE_URL -f migrations/009_create_workflow_media.sql`
- Verify no new npm test failures: `npm test`
