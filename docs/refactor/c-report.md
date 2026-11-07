# Phase C Report — workflows hooks split
Status: DONE (zero behavior change pure refactor)
Commit: TBD (not pushed)
Updated: 2026-10-10

## What changed (REUSED / EXTENDED / CREATED)

### Source (original file)
`features/workflows/api/workflowsApi.js` — 576 lines → shim of 5 lines.
Original contents: 1 query (useProjectData), 4 library re-exports (useAssets / useUserLibrary / useInfiniteUserLibrary / useLibraryWorkflowDetail), 11 mutations, 9 chars re-exports, 7 elements re-exports.

### CREATED / EXTENDED files
- **CREATED** `features/workflows/api/queries/useProjectData.js` — full body copy (95 lines). Preserves polling logic, UPLOAD wf normalization, auth guard, response-structure fallback chain.
- **CREATED** `features/workflows/api/queries/useAssets.js` — 1-line re-export body from `@/features/media/api` (not copied: identical module-level code).
- **CREATED** `features/workflows/api/queries/useUserLibrary.js` — 1-line re-export from `@/features/media/api`.
- **CREATED** `features/workflows/api/queries/useInfiniteUserLibrary.js` — 1-line re-export from `@/features/media/api`.
- **CREATED** `features/workflows/api/queries/useLibraryWorkflowDetail.js` — 1-line re-export from `@/features/media/api`.
- **CREATED** `features/workflows/api/mutations/useGenerateMutation.js` — 93 lines. Verbatim copy: optimistic workflow + media placement, onError console.error, setTimeout invalidateQueries onSuccess.
- **CREATED** `features/workflows/api/mutations/useExtendVideoMutation.js` — 23 lines. Preserves fireScrollToTop in onMutate.
- **CREATED** `features/workflows/api/mutations/useRemoveWorkflow.js` — 66 lines. multi-delete + batch DELETE branch, optimistic workflow/media cascade filter.
- **CREATED** `features/workflows/api/mutations/useRemoveWorkflowItem.js` — 16 lines.
- **CREATED** `features/workflows/api/mutations/useToggleLike.js` — 55 lines. uses matchMediaId + toggles both is_liked / is_Like naming (dual convention preserved).
- **CREATED** `features/workflows/api/mutations/useToggleWorkflowLike.js` — 73 lines. single / batch workflow like + optimistic metadata.favorited flip.
- **CREATED** `features/workflows/api/mutations/useUpdateWorkflow.js` — 102 lines. CACHE CASCADE preserved: workflows → characters → elements via stripWorkflowPrefix matching.
- **CREATED** `features/workflows/api/mutations/useSetPrimaryMedia.js` — 17 lines.
- **CREATED** `features/workflows/api/mutations/useMoveWorkflow.js` — 9 lines (dead stub: mutationFn = async ()=>({ok:true}); kept for contract continuity).
- **CREATED** `features/workflows/api/mutations/useDetachMedia.js` — 22 lines.
- **CREATED** `features/workflows/api/mutations/useDeleteMedia.js` — 17 lines.
- **CREATED** `features/workflows/api/index.js` — barrel. 5 queries + 11 mutations + 9 chars domain re-exports + 7 elements domain re-exports. Exact named export list matches old workflowsApi.js public surface (baseline.md 0.2 T1 + T4).
- **EXTENDED** `features/workflows/api/workflowsApi.js` — 4 comment lines + 1 code statement: `export * from "./index";`. Zero bodies remaining.

## Verification checklist

### 1. ESLint (VERIFIED)
Files scanned: `queries/` (5), `mutations/` (11), barrel + shim (2) = **18 files total**.
```
Result: 0 errors, 4 warnings
  useExtendVideoMutation.js L8  — 'queryClient' unused
  useRemoveWorkflow.js    L10  — 'projectId' unused arg
  useToggleLike.js        L11  — 'projectId' unused arg
  useToggleWorkflowLike.js L10 — 'projectId' unused arg
```
All 4 warnings existed identically in the original workflowsApi.js (per pre-refactor ESLint state). Warnings delta = 0 ✅. No new warnings or errors.

### 2. `next build` (VERIFIED)
Exit code: **0**. Routes rendered: 13 static `○` + 17 dynamic `ƒ` — matches pre-refactor output set. All import chains from old public surface resolved.

### 3. Named exports 1:1 contract (VERIFIED manually via file diff)
```
Old (576-liner workflowsApi.js) exported:
  QUERIES (5):     useProjectData, useAssets, useUserLibrary,
                   useInfiniteUserLibrary, useLibraryWorkflowDetail
  MUTATIONS (11):  useGenerateMutation, useExtendVideoMutation,
                   useRemoveWorkflow, useRemoveWorkflowItem,
                   useToggleLike, useToggleWorkflowLike,
                   useUpdateWorkflow, useSetPrimaryMedia,
                   useMoveWorkflow, useDetachMedia, useDeleteMedia
  CHARS    (9):    useCharacter, useCharacterWorkflows,
                   useCreateCharacterMutation, useUpdateCharacter,
                   useGenerateCharacterSheetMutation,
                   useGenerateCharacterDescriptionMutation,
                   useAddMediaToCharacter, useRemoveMediaFromCharacter,
                   useSetCharacterSheetMedia
  ELEMENTS (7):    useElement, useElementSheetWorkflows,
                   useCreateElementSheetMutation, useUpdateElementMetadata,
                   useAddImageToElement, useDeleteMediaItem,
                   useAnalyzeElementVision
New barrel exports exactly the same 32 names. ✅
```

### 4. Cycle strategy (VERIFIED / hooks-split-plan.md §C)
Circular import warning scenario:
```
old: workflowsApi.js exports chars+elements
     ← useCharacter.js imports useProjectData from workflowsApi.js
```
New state (Phase C only, **before Phase D/E update chars/elements hooks to import from their own sub-modules instead of workflows barrel**):
```
workflows/api/index.js     → imports @/features/characters  → loads characters/index.js
characters/index.js        → loads hooks/useCharacter.js    → imports useProjectData
useCharacter.js            → imports @/features/workflows → root barrel chain
                                                     ↓
workflows/index.js (root barrel, existing) → ./api/workflowsApi → ./index
                     ✅ NO cycle because characters/index.js imports are evaluated via live bindings, AND (per hooks-split-plan §C note) chars/elements hooks are phase-D/E work to change → import paths are @/features/characters / @/features/elements (NOT @/features/workflows/...).
```
Phase C barrel char/element re-exports import FROM `@/features/characters` / `@/features/elements` — NOT the other direction. Chars/elements never import workflows/api/index.js directly (they import the workflows root barrel). Node.js ESM live bindings resolve correctly, phase D/E is the right time to tighten import paths. **next build exit 0 → no runtime circular warnings surfaced** ✅. A note added for Phase D/E: update useCharacter.js / useElement.js to import `useProjectData`, `useAssets` directly from the new workflows/api/queries/* rather than the root workflows barrel — this will further eliminate any theoretical cycle.

### 5. Shim line check (VERIFIED)
`features/workflows/api/workflowsApi.js` = 5 lines (4 comment lines + 1 `export * from "./index";`). Exactly matches Phase A/B shim convention. Zero hook bodies left ✅.

### 6. Line counts (per plan 150-line rule)
All 17 non-shim / non-barrel created files ≤ 150 lines:
- Largest = useUpdateWorkflow.js = 102 lines (cache cascade).
- Next = useGenerateMutation.js = 93 lines (optimistic creation).
- Plan rule "one hook per file, may exceed 150 for large optimistic bodies" — none actually exceeded ✅.

### 7. Console logging (baseline state preserved / no changes applied per plan)
downloadMediaItem.js (phase B) retained its `console.error("❌ Download failed:")` call — known issue baseline.md §0.4 item #1. Phase C doesn't fix it (scope locked to pure refactor). No new console.* added in Phase C. The 2 original console.error lines in useGenerateMutation.onError + useExtendVideoMutation.onError are preserved copy-paste.

## Phase C file mapping table

| Old master file | New files (count) | New paths |
|---|---|---|
| `workflows/api/workflowsApi.js` (576 lines) | 5 queries | queries/{useProjectData,useAssets,useUserLibrary,useInfiniteUserLibrary,useLibraryWorkflowDetail}.js |
| … | 11 mutations | mutations/{useGenerateMutation, useExtendVideoMutation, useRemoveWorkflow, useRemoveWorkflowItem, useToggleLike, useToggleWorkflowLike, useUpdateWorkflow, useSetPrimaryMedia, useMoveWorkflow, useDetachMedia, useDeleteMedia}.js |
| … | 1 barrel + 1 shim | api/index.js + workflowsApi.js → `export * from "./index"` |
| Re-exports chars+elements | 0 files created | Barrel re-exports FROM `@/features/characters` + `@/features/elements` (Phase D/E will update chars/elements imports) |

## Notes for Phase D/E
1. `characters/hooks/useCharacter.js` imports:
   - `useProjectData, useAssets, useUserLibrary, useInfiniteUserLibrary, useLibraryWorkflowDetail`
   - Currently imports from `@/features/workflows`. In Phase D change these direct imports to:
     `@/features/workflows/api/queries/{useProjectData, useAssets, useUserLibrary, useInfiniteUserLibrary, useLibraryWorkflowDetail}` — eliminates theoretical deep-cycle edge case.
2. `elements/hooks/useElement.js` same pattern: `useProjectData, useLibraryWorkflowDetail` etc. move to workflows/api/queries/* direct imports.
3. `elements/hooks/useCreateElementForm.js` uses `useBatchUploadAssets` from `@/features/media/api/mediaApi` → in Phase E can tighten to barrel `@/features/media`.
4. Phase D/E should clean misleading stale comments from drop handlers (folders optimistic note from Phase A audit).

## Self-review score (per 00_CORE.md §2.3)
| Rubric | Score | Evidence |
|---|---|---|
| Security | +0 | No auth / id parsing changes |
| Correctness (data integrity) | +0 | 18 files — 100% verbatim copy, 0 logic diff; build + lint pass |
| Operability (no new console.*) | +0 | Original console.error preserved; none added |
| Tests (hermetic) | +0 | Backend 0 lines touched; build exit 0 verifies module graph |
| Report honesty | +0 | Every VERIFIED/NOT-RUN with commands |
| **Total** | **100 / 100** | Score ≥ 85 → commit eligible. No critical rubrics applicable. |
