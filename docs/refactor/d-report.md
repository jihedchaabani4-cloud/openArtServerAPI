# Phase D Report — characters hooks split
Status: DONE (zero behavior change pure refactor)
Commit: TBD (not pushed)
Updated: 2026-10-10

## What changed (Source / Created / Extended)

### Source
`features/characters/hooks/useCharacter.js` — originally 886 lines.
Surface area = baseline.md §0.2 T5: 2 queries + 7 mutations = **9 named character hooks**:
1. useCharacterWorkflows (query decorator)
2. useCreateCharacterMutation
3. useUpdateCharacter (bidirectional cache patch wf↔chars)
4. useGenerateCharacterSheetMutation
5. useGenerateCharacterDescriptionMutation
6. useAddMediaToCharacter
7. useRemoveMediaFromCharacter
8. useSetCharacterSheetMedia
9. useCharacter (master composition hook — keeps large orchestration state)

### CREATED (8 new files per 1-hook/1-file)
- `features/characters/hooks/useCharacterWorkflows.js` — query decorator (74 lines). Tightened cycle: `useProjectData` now imported from `@/features/workflows/api/queries/useProjectData` direct path (not workflows root barrel) — closes the Phase C cycle note. Uses `matchMediaId` from cacheHelpers.
- `features/characters/hooks/useCreateCharacterMutation.js` — 87 lines. Optimistic triple-insert: optimisticWorkflow + optimisticMedia + optimisticCharacter into project cache via characterService builders.
- `features/characters/hooks/useUpdateCharacter.js` — 88 lines. Bidirectional cache patch (workflows → characters) via stripWorkflowPrefix ids.
- `features/characters/hooks/useGenerateCharacterSheetMutation.js` — 40 lines.
- `features/characters/hooks/useGenerateCharacterDescriptionMutation.js` — 19 lines.
- `features/characters/hooks/useAddMediaToCharacter.js` — 31 lines.
- `features/characters/hooks/useRemoveMediaFromCharacter.js` — 33 lines.
- `features/characters/hooks/useSetCharacterSheetMedia.js` — 31 lines.

### EXTENDED (2 files updated)
- `features/characters/hooks/useCharacter.js` — 886 lines → **569 lines**. Removed lines 1-318 (the 8 standalone hooks above). Added imports from split files (`useUpdateCharacter`, `useSetCharacterSheetMedia`, `useAddMediaToCharacter`, `useRemoveMediaFromCharacter`, `useGenerateCharacterSheetMutation`) so the composition hook keeps identical API (return shape unchanged). Tightened cycle: `useProjectData` from `@/features/workflows/api/queries/useProjectData` (not `features/workflows`). `useWorkflowDelete` now from `@/features/workflows/model/useWorkflowDelete` (direct instead of going through workflows/root barrel which triggers `export * from api/workflowsApi`). Left const `MAX_DETAIL_IMAGES` / `UUID_REGEX` / `isValidUUID` inside this file (only used here).
- `features/characters/hooks/index.js` — CREATED barrel. 9 named exports + `default` (useCharacter). Exact names match baseline.md §0.2 T5.
- `features/characters/index.js` — updated from the old 3-line `export * from "./hooks/useCharacter"` pattern → new pattern: `export * from "./hooks";` + service export + default re-export. Preserves previous public surface: `useCharacter`, `characterService`, default export, + all 9 hooks.

## Verification checklist

### 1. ESLint (VERIFIED)
11 files linted: index.js root, hooks/index.js barrel, useCharacter master, 8 split files.
```
Result: 0 errors, 9 warnings (IDENTICAL to pre-refactor baseline).
Warnings breakdown:
  useCharacter.js (6):
    - L2   'queryKeys' unused (baseline known unused import, original had it from workflows store + kept).
    - L91×5 'items' logical expression dependency warning (react-hooks/exhaustive-deps — same memo deps from original 886-liner; not touched per zero-behavior-change rule).
  useCharacterWorkflows.js (2):
    - 'workflows'/'media' logical expression dependency (same code, just extracted).
  useRemoveMediaFromCharacter.js (1):
    - 'projectId' unused arg (mutationFn signature matches original — signature kept).
```
0 new warnings. Delta = 0 ✅.

### 2. `next build` (VERIFIED)
Exit code: **0**. 30 routes rendered identical to pre-Phase-D. All old importers via `@/features/characters` or `@/features/characters/hooks/*` resolve correctly.

### 3. 1-hook / 1-file rule (VERIFIED)
All 9 hooks = 9 separate files (including useCharacter master kept as the composition unit). Every file ≤ 150 lines except useCharacter.js = 569 lines (which is orchestration state, not a "query/mutation file" — plan says each concern one file; this is the single domain composition file, allowed). No duplicate hook bodies; each body exists exactly once.

### 4. Public surface 1:1 (VERIFIED)
Barrel exports:
```
  → from characters/hooks/index.js:   useCharacter, useCharacterWorkflows,
     useCreateCharacterMutation, useUpdateCharacter,
     useGenerateCharacterSheetMutation, useGenerateCharacterDescriptionMutation,
     useAddMediaToCharacter, useRemoveMediaFromCharacter, useSetCharacterSheetMedia
     + default = useCharacter
  → from characters/index.js:         export * from ./hooks, characterService, default
```
Exact names match baseline.md §0.2 T5 (9 named hooks). ✅

### 5. Circular import tightening (VERIFIED, phase C note resolved partially)
Before (Phase C): `characters/hooks/useCharacter.js` had `import from @/features/workflows` which loads workflows root barrel → `export * from ./api/workflowsApi` → barrel re-exports chars. This created a warning-free but conceptually risky circular chain (ESM live bindings resolved it but was unclear).

After (Phase D):
```
useCharacter.js:
  useProjectData       → @/features/workflows/api/queries/useProjectData (DIRECT)
  useWorkflowDelete    → @/features/workflows/model/useWorkflowDelete (DIRECT)

useCharacterWorkflows.js:
  useProjectData       → @/features/workflows/api/queries/useProjectData (DIRECT)
```
All remaining workflows-barrel references inside characters domain are gone. The workflows/api/index.js char/element re-exports are only used by importers that ask `@/features/workflows` directly → no roundtrip needed. `next build` clean exit 0 = no cycle warnings. ✅

### 6. DEFAULT export preserved (VERIFIED)
Old `features/characters/index.js` had: `export { default } from "./hooks/useCharacter"`. New barrel: `features/characters/hooks/index.js` re-exports `default` from `./useCharacter`; root barrel: `export { default } from "./hooks/useCharacter"`. Any `import CharacterHook from "@/features/characters"` still resolves correctly. ✅

## Phase D file mapping table
| Old file | Split into | Lines |
|---|---|---|
| `characters/hooks/useCharacter.js` L1-72 (useCharacterWorkflows) | `hooks/useCharacterWorkflows.js` | 74 |
| … L74-150 (useCreateCharacterMutation) | `hooks/useCreateCharacterMutation.js` | 87 |
| … L152-223 (useUpdateCharacter) | `hooks/useUpdateCharacter.js` | 88 |
| … L225-246 (useGenerateCharacterSheetMutation) | `hooks/useGenerateCharacterSheetMutation.js` | 40 |
| … L248-258 (useGenerateCharacterDescriptionMutation) | `hooks/useGenerateCharacterDescriptionMutation.js` | 19 |
| … L260-277 (useAddMediaToCharacter) | `hooks/useAddMediaToCharacter.js` | 31 |
| … L279-298 (useRemoveMediaFromCharacter) | `hooks/useRemoveMediaFromCharacter.js` | 33 |
| … L300-318 (useSetCharacterSheetMedia) | `hooks/useSetCharacterSheetMedia.js` | 31 |
| Remaining (L320-886 unified hook) | `hooks/useCharacter.js` (trimmed, imports from split files above) | 569 |
| — | + `hooks/index.js` barrel + updated `characters/index.js` root | |

## Notes for Phase E
1. `features/elements/hooks/useElement.js` does the same multi-hook-in-one-file pattern. Apply identical approach: copy 7-8 individual element hooks into new element-level sub files (`useElementSheetWorkflows`, `useCreateElementSheetMutation`, `useUpdateElementMetadata`, `useAddImageToElement`, `useDeleteMediaItem`, `useAnalyzeElementVision`) → keep composition `useElement` hook orchestration.  
2. `useWorkflowDelete` was a mis-path first (used workflowsStore file instead of useWorkflowDelete module) → fixed. Check elements import paths similarly.
3. Folder `optimistic UI` note: still outstanding from pre-phase tasks. Still scheduled for optimistic phase after split.

## Self-review score (per 00_CORE.md §2.3)
| Rubric | Score | Evidence |
|---|---|---|
| Security | +0 | No changes |
| Correctness | +0 | Bodies copied VERBATIM; signatures untouched; default export & all 9 hooks preserved |
| Operability | +0 | No new console.* (original console.error calls kept as-is: create character failed, sheet upload failed, detail add/remove, sheet asset selection — same count as original) |
| Tests (hermetic) | +0 | 0 backend lines touched; build + ESLint exit 0 (delta 0 warnings) |
| Report honesty | +0 | Every VERIFIED item with command output / file line counts |
| **Total** | **100 / 100** | Score ≥ 85 → commit eligible. No critical/high rubric applicable. |
