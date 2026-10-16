# OWN-CHAR-1: Character Controller & Service Boundary Ownership & Normalization

Status: DONE
Commit: 373bb8d
Self-review score: 99/100 (loops: 1)
Baseline `npm test` before: PASS (704/704 pass across 152 suites; failing-first on new boundary tests: 9 pass, 4 fail)
After `npm test`: PASS (709/709 pass across 152 suites hermetically — +5 passing tests, 0 failures)

## What changed (REUSED / EXTENDED / CREATED)

- EXTENDED `src/domain/character/CharacterService.js`:
  - Imported `assertOwnsAny` and `toMediaIdList` from `../../platform/security/ownership.js` (Decision `D-29`).
  - Added strict `if (!userId)` fail-closed checks on `createCharacter` and `generateCharacterSheet`.
  - Removed dangerous `safeUserId` fallback where missing or non-UUID `userId` silently adopted `proj.user_id`.
  - Normalized `references` with `toMediaIdList(references)` and enforced `assertOwnsAny(["character", "media", "element", "workflow"], refId, userId)` at the service entry point before any `workflows`, `characters`, or `media` placeholder rows are created, and before any billing holds are reserved.
  - Replaced legacy `console.*` with structured `createLogger("character-service")`.
- EXTENDED `src/domain/character/CharacterGenerationService.js`:
  - Imported `toMediaIdList` and normalized `references` via `toMediaIdList(references)` in `runtimeInput`.
- EXTENDED `tests/boundary/characterAndElementOwnershipBoundary.test.js`:
  - Added mock tracking for `workflowCreationCalls`, `characterUpsertCalls`, `enqueueCalls`.
  - Added failing-first test evidence (`TESTS 9–13`): cross-tenant character references (404), unowned element/media references (404), unowned project (404), sheet regeneration with foreign references (404), and string-to-array reference normalization (200).
- EXTENDED `docs/plan/DECISIONS.md` (`D-29`), `docs/plan/BACKLOG.md`, `docs/plan/STATE.md`.

---

## Evidence

- **VERIFIED**: `node --import ./tests/setup-env.js --test tests/boundary/characterAndElementOwnershipBoundary.test.js` -> `13 tests, 13 pass, 0 fail` (889ms).
- **VERIFIED**: `node --import ./tests/setup-env.js --test tests/boundary/referenceAndMediaOwnershipBoundary.test.js` -> `13 tests, 13 pass, 0 fail` (954ms).
- **VERIFIED**: `npm test` -> `709 tests, 152 suites, 709 pass, 0 fail` (0 failures across all 152 suites).
- **VERIFIED**: `git diff --cached | Select-String -Pattern "(sk_|rk_|eyJ|SUPABASE_SERVICE|Bearer [A-Za-z0-9._-]{20,}|-----BEGIN|console\.(log|warn|error))"` -> 0 hits.
- **VERIFIED**: No `console.*` added in new code.

## Self-review findings

- PASS — Security: Every input `references` ID is validated with `assertOwnsAny` before database mutations or billing holds. Cross-tenant access returns 404 immediately.
- PASS — Correctness: Eliminates silent fallback identity vulnerability; normalizes strings, objects, and arrays consistently.
- PASS — Operability: Structured logger used; zero `console.*`.
- PASS — Tests: Failing-first verified (4 failures before fix); full hermetic test suite passes (709/709).
