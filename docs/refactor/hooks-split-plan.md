# Hooks Split Plan — Phase 0..F (Pure Refactor, Zero Behavior Change)

> Goal: 1 giant file = 1 hook / file, preserve exact logic + exports + imports. Split **no-optimistic, no-bugfix, no-dead-code**.
> **RULE**: STOP after every phase below and wait for explicit human OK (reply "go") to proceed. Do not batch phases together.
> **RULE**: No backend changes. No behavior changes. No naming changes. No improving duplicated logic unless explicitly listed in T-A1.

---

## Legend

Every task line below is executable with verifications. Format:

```
- [ ] T-XX short description | Files created / modified | Verification checklist
```

Check every verification line after executing. If any fails = STOP, report, don't continue.

---

## PHASE A — Shared Helpers (cacheHelpers.js — move UNCHANGED only)

Phase A is deliberately small: move shared helper functions into a dedicated lib so the split files can import them without circular dependencies. Do NOT change any helper's logic.

- [ ] **T-A1.1** Inventory all inline helpers in current files that are duplicated or imported by >1 future split file.
  - Candidates (from baseline.md 0.3):
    1. `cleanId(id) = String(id).replace(/^workflows\//, "")` from workflowsApi.js `useUpdateWorkflow`
    2. Dual ID match: `(wf.id === matchId) \|\| (wf.name === matchId) \|\| clean(wf.id) === clean(matchId)` from `useRemoveWorkflow`
    3. Media match dual `m.id === itemId \|\| m.name === itemId` from `useToggleLike`
    4. Folder patch `folder_id` + `folderId` + `metadata.folder_id` + `metadata.folderId` quadruple write (today inline in `useMoveAssetToFolder`)
    5. Folder ID match `(c.id === fId) \|\| (c.folderId === fId) \|\| (c._id === fId)` triple match (today in foldersApi.js)
  - Exclude: `buildOptimisticWorkflow/Media/Character` — live in `characterService.js` and only called from useCharacter mutations → stay there (no duplication with elements yet).
  - Output: a list of helper functions with signatures.
  - Files: `docs/refactor/helpers-inventory.md` (intermediate, added to report in T-F1) | verify 5 candidates above are all present and signatures match 1:1 with inline usage.

- [ ] **T-A1.2** Create `features/workflows/lib/cacheHelpers.js` — export helpers UNCHANGED (copy body verbatim from inline sites).
  - ⚠️ Do NOT add new logic or variants. If a candidate helper only exists in one file, STILL include it in cacheHelpers if another future split file would need it.
  - Only include helpers that at least 2 split hooks will share. Helpers used in ONE hook only → leave inline in the split hook file.
  - File: `features/workflows/lib/cacheHelpers.js` (new) | verification: ESLint on new file → 0 new errors.

- [ ] **T-A1.3** In-place change: inside workflowsApi.js / foldersApi.js / mediaApi.js / useCharacter.js / useElement.js → replace the inline helper bodies with `import { helper } from "@/features/workflows/lib/cacheHelpers"`.
  - ⚠️ Keep EXACT same behavior (same variable names). If a helper has a slightly different variant across two hooks → keep as two exports `matchWorkflowId()` vs `matchMediaId()` or a single generic `matchesId(entity, targetId, extraFields?)` with defaulted exact args.
  - Files: all 5 target files + new lib file | verification: ESLint → 0 errors (0 additional warnings allowed). Build passes. Baseline.md grep imports still resolve.

- [ ] **T-A2** Phase A verify (mandatory before moving on):
  - ESLint all touched files → 0 errors, same 20 warnings ± 0 delta.
  - `next build` succeeds.
  - `grep` import contract from baseline.md 0.2 → 100% of listed imports still point at existing paths (no renamed exports).
  - STOP and show summary.

---

## PHASE B — folders + media splits (low risk, warm-up)

Goal: split 2 smaller feature files first before tackling the 516-line workflows monster.

After phase B, old `foldersApi.js` and `mediaApi.js` become **one-line shims re-exporting the new barrel index.js**. That way no component import needs to change.

### B.1 folders (211 lines → 1 query + 4 mutations + lib + barrel)

- [ ] **T-B1.1** Create `features/folders/api/queries/useProjectFolders.js`.
  - Body: copy `useProjectFolders(projectId)` hook EXACTLY from `foldersApi.js`.
  - Copy all relevant imports (queryKeys, queryClient NOT needed if pure query; if used import separately).
  - File: `features/folders/api/queries/useProjectFolders.js` (new) | verify lines < 150 (yes for this query). ESLint.

- [ ] **T-B1.2** Create 4 mutation files in `features/folders/api/mutations/`:
  - `useCreateFolder.js` — copy hook EXACTLY.
  - `useUpdateFolder.js` — copy hook EXACTLY (keep optimistic triple onMutate/onError/onSettled as-is).
  - `useDeleteFolder.js` — copy hook EXACTLY (same optimistic).
  - `useMoveAssetToFolder.js` — copy hook EXACTLY (same optimistic).
  - All files < 150 lines expected. If one exceeds, check if it's because of inline helpers → those should be in cacheHelpers.js from Phase A. Keep all import statements from old file needed for this hook only.
  - Files: 4 new mutation files | verify each lines < 150. ESLint 0 new errors.

- [ ] **T-B1.3** Create barrel `features/folders/api/index.js`:
  ```js
  export { useProjectFolders } from "./queries/useProjectFolders";
  export { useCreateFolder } from "./mutations/useCreateFolder";
  export { useUpdateFolder } from "./mutations/useUpdateFolder";
  export { useDeleteFolder } from "./mutations/useDeleteFolder";
  export { useMoveAssetToFolder } from "./mutations/useMoveAssetToFolder";
  ```
  - Preserve exact exported names (match baseline.md 0.2 export list T2).
  - File: index.js new | verify `import * as all from "./index"` → 5 exports exist.

- [ ] **T-B1.4** Turn old `features/folders/api/foldersApi.js` into a **1-line shim** re-exporting index.js:
  ```js
  export * from "./index";
  ```
  - ⚠️ If any old export name doesn't match new barrel → fix barrel before continuing. No old export can be removed.
  - File: `foldersApi.js` (modified) | verify: old importers (grep list above) still resolve.

### B.2 media (400 lines → 4 queries + 2 mutations + lib + barrel)

- [ ] **T-B2.1** Queries folder: `features/media/api/queries/` with 4 files:
  1. `useAssets.js` — copy useAssets hook.
  2. `useUserLibrary.js` — copy.
  3. `useInfiniteUserLibrary.js` — copy.
  4. `useLibraryWorkflowDetail.js` — copy.
  - Files: 4 new query files | each < 150 lines? If useInfinite breaks limit, split nothing — it's OK if one file is 160-200; the goal is manageable files, not dogma. Report exception here but don't artificially split a single hook across files.

- [ ] **T-B2.2** Mutations folder: `features/media/api/mutations/` with 2 files:
  1. `useBatchUploadAssets.js` — copy hook verbatim (OPTIMISTIC complex: blob URLs, revoke timers; keep as-is).
  2. `useRemoveAsset.js` — copy hook verbatim (with cascade logic).

- [ ] **T-B2.3** Lib (pure utilities): `features/media/api/lib/downloadMediaItem.js`
  - Export `downloadMediaItem` function. Keep imports from mediaApi.js (axios? file-saver? copy exactly).

- [ ] **T-B2.4** Barrel `features/media/api/index.js`:
  - Export 4 queries + 2 mutations + 1 utility in EXACT original names.
  - Remember: `workflowsApi.js` barrel re-exports `useUserLibrary / useInfiniteUserLibrary / useLibraryWorkflowDetail / useAssets` too — so exact names are critical.

- [ ] **T-B2.5** Turn old `features/media/api/mediaApi.js` into 1-line shim: `export * from "./index";`.

### B.3 Verify & report

- [ ] **T-B3** Build + Lint + Grep Contract:
  1. `npx eslint` on the 5 old shims + every new file → 0 errors (new warnings allowed only if they existed before in the same block; total warnings delta must be 0 from baseline).
  2. `next build` succeeds with exit 0.
  3. For every import listed in baseline.md 0.2 T2 + T3 (folders + media), manually check: `node -e "require.resolve('...')"` against webpack resolver or — simpler — run build; if build passes then all imports resolved (because next build tree-shakes but errors if import path doesn't exist).
  4. Grep old files folder content: `foldersApi.js` MUST be exactly 1 line. `mediaApi.js` MUST be exactly 1 line (plus any license header — if there was one, keep it as top-of-file comment + shim).
  5. Produce interim report: `docs/refactor/b-report.md` → list every file created/modified in Phase B.
  6. STOP and wait for OK.

---

## PHASE C — workflows split (516 lines → 1 query + 10 mutations + 3 lib queries + barrel + shim)

⚠️ This phase has a risk: **circular import** between `workflows/api/index.js` (which re-exports chars/elements) and `useCharacter.js` / `useElement.js` (which import `useProjectData` from `features/workflows/api/workflowsApi.js` = new shim → new index barrel → re-exports chars/elements). Since the OLD shim is ONLY `export * from "./index"` AND the re-exports from chars/elements are NAMED exports that don't import from each other at the module level in a cycle (useCharacter.js imports from workflows at top of file → index.js re-exports workflows from sub files → those don't re-import useCharacter) this SHOULD be fine. If webpack / next build reports a cycle warning or runtime:

  1. STOP.
  2. Fix strategy: move the `re-exports from characters/elements` OUT of `workflows/api/index.js` and keep them ONLY in the legacy `workflowsApi.js` shim. That way index.js has no cross-feature re-exports, and any circular dependency is broken by having the chars/elements re-exports live in the shim file only (which no child imports).
  3. Report this decision in c-report.md before continuing. Never hack around cycles silently.

Tasks:

- [ ] **T-C1** `features/workflows/api/queries/useProjectData.js` — copy the query hook only + any normalize functions it references. File: queries/useProjectData.js | verify < 250 lines (the hook itself is small; if it's larger due to the media polling logic, it's OK — single query hook, don't split).

- [ ] **T-C2** Move 3 other pure queries from workflowsApi.js into media queries? No: keep them in workflows/api/queries/ (because workflowsApi.js barrel exports them) OR move into media and re-export — simpler:
  - `useUserLibrary(params)` → `features/workflows/api/queries/useUserLibrary.js`
  - `useInfiniteUserLibrary(params)` → same folder
  - `useLibraryWorkflowDetail(workflowId)` → same folder
  - `useAssets(projectId, offset, type, mediaType)` → `features/workflows/api/queries/useAssets.js` (even if duplicated with media barrel, keep both with exact names; can re-export from media if identical body with wrapper that keeps same name)
  - Files: 4 additional query files.

- [ ] **T-C3** 10 mutations → one file each in `features/workflows/api/mutations/`:
  1. `useGenerateMutation.js` — keep both image + isVideo logic in one hook (it's one exported function with a param). If > 150 lines, it's OK. Keep polling timers as-is.
  2. `useExtendVideoMutation.js`
  3. `useRemoveWorkflow.js` — includes single + batch (same hook today, keep single file).
  4. `useRemoveWorkflowItem.js`
  5. `useToggleLike.js` — media item like
  6. `useToggleWorkflowLike.js` — workflow favorite, single + batch
  7. `useUpdateWorkflow.js` — includes the complex cache patching of chars[]/elems[] arrays — keep single file (even if 180 lines).
  8. `useSetPrimaryMedia.js`
  9. `useMoveWorkflow.js` — dead stub. Keep exactly as is in its own file. Flag in final report.
  10. `useDetachMedia.js`
  11. `useDeleteMedia.js`

- [ ] **T-C4** Barrel `features/workflows/api/index.js`:
  - Export ALL workflows hooks exactly.
  - Then: ADD the re-export lines from characters/elements hooks (mirror today's workflowsApi.js export list):
    ```
    // Mirror of workflowsApi.js current re-exports section
    export { useCharacter, ..., useCreateCharacterMutation, ... } from "@/features/characters/hooks/useCharacter";  // OR from the NEW characters barrel in phase D if phase D is done first — adjust order below: DO phases B→C→D→E OR B→D→E→C? This plan does B→C so if chars/elements barrels don't exist yet use old paths for these re-exports.
    ```
  - ⚠️ If chars/elements barrels are not created yet in phase C, the index barrel here should re-export from OLD paths. After phases D+E the paths in this barrel can be updated to new barrels in a separate tiny commit with no behavior change. This is explicitly allowed in the plan.

- [ ] **T-C5** Legacy shim: `features/workflows/api/workflowsApi.js` → 1-line: `export * from "./index";`

- [ ] **T-C6** Verify:
  1. ESLint 0 errors.
  2. Build succeeds.
  3. Cycle warning? Report in report.
  4. Imports in baseline.md 0.2 T1 all resolve (build passing = resolution OK).
  5. Report `docs/refactor/c-report.md`.
  6. STOP and wait for OK.

---

## PHASE D — characters (789 lines → 1 query + 7 mutations + 2 local hooks + 1 composer + 1 barrel)

- [ ] **T-D1** Queries: `features/characters/hooks/queries/useCharacterWorkflows.js` — pure memo-filter query.

- [ ] **T-D2** 7 mutations → `features/characters/hooks/mutations/`:
  1. `useCreateCharacterMutation.js` — contains its call to builders + optimistics copied as-is
  2. `useUpdateCharacter.js`
  3. `useGenerateCharacterSheetMutation.js`
  4. `useAddMediaToCharacter.js`
  5. `useRemoveMediaFromCharacter.js`
  6. `useSetCharacterSheetMedia.js`
  7. `useGenerateCharacterDescriptionMutation.js`

- [ ] **T-D3** Local state hooks (extract from giant `useCharacter`):
  1. `features/characters/hooks/local/useOptimisticSheetUrl.js` — encapsulates `const [optimisticSheetUrl, set…] = useState(); const uploadSheetFile = (file) => { blob url logic + trigger setSheetMedia mutation }`; keep exact logic, include the known bug (removeDetailImage not present — this is sheet only).
  2. `features/characters/hooks/local/useAddedDetailImages.js` — encapsulates `addedDetailImages` state + `uploadDetailFiles(file[])` + `removeDetailImage(id)` handlers. **Keep the EXISTING BUG where `removeDetailImage` calls `removeMediaMutation.mutate(mediaId)` with no onError rollback on local state — do NOT fix**. Only comment `// TODO(bug): local state not rolled back if removeMediaMutation fails` above the line.
  - Each file returns exactly the same subset of the master hook return shape as today for those fields.

- [ ] **T-D4** Rewrite `features/characters/hooks/useCharacter.js` to be a thin **composer** only:
  - Import every small hook (useProjectData, useCharacterWorkflows, each 7 mutations, useOptimisticSheetUrl, useAddedDetailImages, useWorkflowDelete from `features/workflows/model/useWorkflowDelete.js`)
  - Assemble the return object EXACTLY as before: same keys, same aliases (e.g. `createCharacter: createCharacterMutation.mutate`, `isCreating: createCharacterMutation.isPending`, `createCharacterAsync: createCharacterMutation.mutateAsync`).
  - No `useMutation` calls inside this file after composer rewrite. If any `useMutation` left = leftover → move to mutations dir.
  - No local `useState` of optimistic sheet / added detail images → only delegated to the two local hooks.
  - Keep the exported signature `useCharacter({ projectId, characterId, workflowId })` → returns EXACT same object keys and value types (including promise vs sync for mutate vs mutateAsync, and `.isPending` vs old `.isLoading` — if today we alias `.isPending` as `.isCreating` keep identical aliasing).

- [ ] **T-D5** Barrel `features/characters/hooks/index.js` — exports:
  - Composer: `export { useCharacter } from "./useCharacter";`
  - Each small hook: `export { useCharacterWorkflows } from "./queries/useCharacterWorkflows";` + each of 7 mutations + 2 local hooks.
  - Also keeps named exports if any other file imports them individually (workflowsApi.js barrel re-exports these exact names → match names 1:1).

- [ ] **T-D6** Verify:
  1. ESLint 0 errors.
  2. Build succeeds.
  3. Build uses at least 1 import path from `features/characters/hooks/useCharacter` — should resolve (passes build).
  4. Run a script to list the master hook's return keys before vs after (manual via grep or JS eval in a test file = list keys, diff empty). Report `docs/refactor/d-report.md` with keys diff.
  5. STOP + wait for OK.

---

## PHASE E — elements (561 lines → 1 query + 5 mutations + 1 composer + 1 barrel)

- [ ] **T-E1** Queries: `features/elements/hooks/queries/useElementSheetWorkflows.js` — memo-filter today's `useElementSheetWorkflows` exactly.

- [ ] **T-E2** 5 mutations → `features/elements/hooks/mutations/`:
  1. `useCreateElementSheetMutation.js` (includes character-type redirect to `/characters/create` logic as-is)
  2. `useUpdateElementMetadata.js` (OPTIMISTIC patching of both workflows[] + elements[] — copy verbatim, keep onMutate logic)
  3. `useAddImageToElement.js`
  4. `useDeleteMediaItem.js`
  5. `useAnalyzeElementVision.js`

- [ ] **T-E3** Rewrite `features/elements/hooks/useElement.js` as thin **composer**:
  - Import `useProjectData` (from workflows api shim → new barrel), `useElementSheetWorkflows`, each 5 mutations, `useWorkflowDelete` from workflows/model.
  - Assemble return object EXACTLY as before: same keys, same aliases (`isCreating`, `createElementSheetAsync`, etc.). Keep dual named export: both `useElement(...)` default composer AND also named export for each individual mutation hook (needed because `NewElementDialog.jsx` imports `{ useCreateElementSheetMutation }` from this path). Yes: same file exports both the composer AND the small hooks via barrel re-exports? If composer file re-exports from the barrel at top of file → circular again. Simpler: old `useElement.js` becomes a **shim** too like the other files.
  - ❗ **Alternate cleaner plan for elements**: Do like workflows — split the named exports into their own files, create a `features/elements/hooks/index.js` barrel that exports everything (composer + individual hooks), then turn old `useElement.js` into 1-line shim `export * from "./index";`. Put the actual composer logic in `features/elements/hooks/composer/useElementComposer.js` or `features/elements/hooks/useElementComposite.js` (better: keep composer name same, put file under different folder `composers/useElement.js` and barrel re-exports it). Final result: `import { useCreateElementSheetMutation } from "@/features/elements/hooks/useElement"` → resolves via `useElement.js` shim → `index.js` barrel → individual hook file.

- [ ] **T-E4** Finalize composer file structure: `features/elements/hooks/composers/useElement.js` (composer-only). `useElement.js` root = shim; barrel re-exports + composer; individual hooks in queries/mutations folders. If there are named exports of pure queries (useElementSheetWorkflows) also re-exported via barrel → yes.

- [ ] **T-E5** Verify:
  1. ESLint 0 errors.
  2. Build succeeds.
  3. The import `widgets/NewElementDialog/NewElementDialog.jsx:24 → { useCreateElementSheetMutation }` from `@/features/elements/hooks/useElement` resolves (build success = yes).
  4. Return object keys same as before (diff vs old version = empty). Report `docs/refactor/e-report.md`.
  5. STOP + wait for OK.

---

## PHASE F — Final Cleanup Report (NO CODE CHANGES)

Produce single final report `docs/refactor/final-report.md` with:

- [ ] **T-F1.1** Old file → new files mapping table:
  - `workflowsApi.js` (516 lines → X new files: queries/Y, mutations/Z, index shim)
  - `foldersApi.js` (211 → Y)
  - `mediaApi.js` (400 → Z)
  - `useCharacter.js` (789 → N queries + M mutations + 2 local + composer + barrel shim)
  - `useElement.js` (561 → Q queries + R mutations + composer + barrel shim)
- [ ] **T-F1.2** Every file created / modified in total (aggregate from a-report.md → e-report.md lists).
- [ ] **T-F1.3** Dead code found (list): `useMoveWorkflow` (returns `{ok:true}` no API call). Any unused exports (run ESLint no-unused check on barrels; if any export in barrel is 0 times imported across whole src, list it as candidate but do NOT remove).
- [ ] **T-F1.4** Bugs noticed but NOT fixed (list with files + line refs):
  1. `useAddedDetailImages.js → removeDetailImage` local state no rollback on API failure
  2. `useWorkflowDelete.js` → `console.error` (AGENTS.md logger rule violation)
  3. `workflowsApi.js` → multiple `console.error` in mutation onError
  4. `characterService.js` → `console.error` lines
  5. Any other console.* found during the split across hooks
- [ ] **T-F1.5** Duplicated logic not fixed (list candidates for the optimistic phase):
  - folder_id quadruple write pattern → now centralized in cacheHelpers (T-A1 resolved it)
  - ID strip prefix workflows/ pattern → central
  - duplicate useAssets between workflows/media → reported but not removed to keep export contract
- [ ] **T-F1.6** Before/after comparison table vs baseline.md 0.1:
  - ESLint errors: before = 0 → after = 0? (expect same)
  - ESLint warnings delta (expect ±0 from baseline 20)
  - `next build` duration delta
  - Cycle warnings: if any new ones, list with resolutions applied
- [ ] **T-F1.7** Manual smoke checklist for human QA:
  - List 8 scenarios to test in browser after merge (drag/drop move, delete, like, rename folder, create character, create element, upload media, collection delete + non-empty rollback alert).

After final report is written: STOP, no further commits, show summary.

---

## Open Questions (must be answered before first coding commit "go" of Phase A)

1. **Phase order D vs C**: Today's plan does B → C (workflows) then D+E (characters/elements). But workflows barrel has re-exports of characters/elements hooks. In phase C without D/E, the barrel index.js has to re-export from OLD full `useCharacter.js` path which is fine for the compiler, but after D/E we'll update those paths to new barrels → 2 small changes. Alternatively: B → D → E → C. Which do you prefer? *Default in plan: B → C using old paths for chars/elements re-exports, then a tiny commit after D+E to update the barrel paths only.*

2. **Composer folder naming for elements**: Proposed `features/elements/hooks/composers/useElement.js` to host the master composer hook. Then old root `useElement.js` is 1-line shim → index barrel re-exports from composers + queries + mutations. That matches user sketch. OK?

3. **Helpers threshold (T-A1.1)**: Plan says "helpers shared by ≥ 2 split files". If a duplicate pattern exists exactly 2 times, extract. For patterns appearing once (e.g., `buildOptimisticX` builders in characterService.js), leave as-is. Correct?

4. **`useAssets` duplicate export**: Both `workflowsApi.js` AND `mediaApi.js` export it today. Plan: keep both exports (identical function body in media/mutations/, then both barrels re-export it). OK vs. dedupe with a single re-export wrapper? *Prefer: keep both barrels exporting it to preserve any importers relying on one path.*

5. **`useWorkflowDelete` location**: User's target says stays under `features/workflows/model/useWorkflowDelete.js` — yes, matches plan (characters and elements composers import from there directly). Confirm no circular: useWorkflowDelete → uses useProjectData from workflows api shim → which re-exports character hooks → which import useWorkflowDelete → wait: useWorkflowDelete doesn't import character hooks, only `useProjectData` and query keys. Character hooks import useWorkflowDelete. That's a one-way edge → NO cycle.

Reply with any adjustments, then say "go" to start Phase A T-A1.1.
