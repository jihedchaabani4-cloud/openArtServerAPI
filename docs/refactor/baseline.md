# Phase 0 Baseline — React Query Hooks Split

Generated on 2026-10-10. Goal: preserve exact behavior & import resolution.

## 0.1 Quality gates (before any code change)

| Check | Result | Notes |
|---|---|---|
| **ESLint (target 5 files)** | **0 errors, 20 warnings** (all pre-existing, no-fix) | warnings = react-hooks/exhaustive-deps + no-unused-vars (projectId/items/queryClient…) |
| **App build (`next build`)** | **SUCCESS (exit 0)**, 69.3 s | All routes rendered (ƒ dynamic / ○ static). No build errors. |
| **Frontend tests (`npm test` / jest)** | **N/A — no test script in `my-app/package.json`** | Only backend has tests (`/apiOpenArt/`). Contract: after refactor, backend tests should be identical (since no backend touched, and frontend tests don't exist this gate is skipped via verification by build + ESLint). |

## 0.2 Split targets: size, export list, import contract

### T1: `features/workflows/api/workflowsApi.js` (516 lines)

#### Exports (5 queries + 12 mutations + 1 dead stub + 7 re-exports):
```
EXPORTS (named):
  useProjectData(query)
  useGenerateMutation(video = false)
  useExtendVideoMutation()
  useRemoveWorkflow()
  useRemoveWorkflowItem()
  useToggleLike()                         — media item like toggle
  useToggleWorkflowLike()                 — workflow favorite toggle
  useUpdateWorkflow()
  useSetPrimaryMedia()
  useMoveWorkflow()                       — DEAD STUB (returns {ok:true}, no API call)
  useDetachMedia()
  useDeleteMedia()
  useUserLibrary(params)                  — query library
  useInfiniteUserLibrary(params)          — infinite query library
  useLibraryWorkflowDetail(workflowId)    — query detail
  useAssets(projectId, offset, type, mediaType) — query (DEPRECATED ALIAS to mediaApi)

RE-EXPORTS (re-exported directly from characters/elements features, same names):
  useCharacter, useCharacterWorkflows,
  useCreateCharacterMutation, useUpdateCharacter,
  useGenerateCharacterSheetMutation, useGenerateCharacterDescriptionMutation,
  useAddMediaToCharacter, useRemoveMediaFromCharacter, useSetCharacterSheetMedia,
  useElement, useElementSheetWorkflows,
  useCreateElementSheetMutation, useUpdateElementMetadata,
  useAddImageToElement, useDeleteMediaItem, useAnalyzeElementVision
```

#### Files that import from `@/features/workflows/api/workflowsApi` (11 files — import contract MUST keep resolving):
1. `app/cinema-studio/[projectId]/layout.js` → `{ useProjectData }`
2. `app/cinema-studio/[projectId]/assets/page.js` → `{ useGenerateMutation }`
3. `app/cinema-studio/[projectId]/assets/edit/[workflowId]/page.js` → `{ useSetPrimaryMedia }`
4. `app/cinema-studio/[projectId]/characters/[workflowId]/page.js` → `{ useProjectData }`
5. `app/cinema-studio/[projectId]/collection/[collectionId]/page.js` → `{ useGenerateMutation }`
6. `app/cinema-studio/[projectId]/edit/[workflowId]/page.js` → `{ useProjectData }`
7. `app/cinema-studio/[projectId]/elements/edit/[workflowId]/page.js` → `{ useProjectData, useSetPrimaryMedia }`
8. `features/assets/ui/LibraryMediaGridItem.jsx` → `{ useRemoveWorkflow, useToggleWorkflowLike }`
9. `features/characters/hooks/useCharacter.js` → `{ useProjectData }`
10. `features/elements/hooks/useElement.js` → `{ useProjectData }`
11. `features/elements/hooks/useElementEdit.js` → `{ useProjectData, useSetPrimaryMedia }`
12. `features/elements/hooks/useNewElement.js` → `{ useProjectData }`
13. `views/AssetsLibraryPage.jsx` → `{ useRemoveWorkflow, useToggleWorkflowLike }`
14. `widgets/EditNavbar/EditNavbar.jsx` → `{ useUpdateWorkflow, useDeleteMedia }`
15. `widgets/ImportMediaDialog/ImportMediaPopover.jsx` → `{ useProjectData }`
16. `widgets/StudioLayout/GenerationsStudio/MediaGridItem/MediaGridItem.jsx` → `{ useUpdateWorkflow }`

⚠️ Watch out: `useAssets()` is exported here as alias — grep shows no file imports it but to preserve contract we must keep exporting it (even if only re-exported from mediaApi barrel). Re-exports block: we need barrel to forward `useCharacter / useElement / etc` exact names.

---

### T2: `features/folders/api/foldersApi.js` (211 lines)

#### Exports (1 query + 4 mutations):
```
EXPORTS (named):
  useProjectFolders(projectId)            — GET /projects/:projectId/folders
  useCreateFolder()                       — POST /projects/:projectId/folders
  useUpdateFolder()                       — PATCH /folders/:folderId (rename + move) (NOW OPTIMISTIC)
  useDeleteFolder()                       — DELETE /folders/:folderId (NOW OPTIMISTIC)
  useMoveAssetToFolder()                  — PATCH /assets/:assetId/folder (NOW OPTIMISTIC)
```

#### Files that import from `@/features/folders/api/foldersApi` (grep didn't return explicit lines but components are implied — check again during phase B against full src):
Confirmed call sites (from prior session):
- `widgets/StudioLayout/GenerationsStudio/MediaGridItem/MediaGridItem.jsx` — uses `useUpdateFolder`/`useMoveAssetToFolder`/`useDeleteFolder` via `useCollectionActions` (if that hook exists; if not in a hook — verify).
- `widgets/StudioNavbar/ui/StudioNavbarLeft.jsx` — same (move to parent/root).
- `app/cinema-studio/[projectId]/assets/page.js` — `useProjectFolders` or inline call?
- `app/cinema-studio/[projectId]/collection/[collectionId]/page.js` — same
- `widgets/CreateCollectionDialog/CreateCollectionDialog.jsx` — `useCreateFolder()`

Full grep contract to produce in Phase B before commit to confirm all imports hit the new barrel via re-export shim.

---

### T3: `features/media/api/mediaApi.js` (400 lines)

#### Exports (4 queries + 2 mutations + 1 utility):
```
EXPORTS (named):
  useAssets(projectId, offset, type, mediaType)    — query /workflows/assets/:project_id
  useUserLibrary(params)
  useInfiniteUserLibrary(params)
  useLibraryWorkflowDetail(workflowId)
  useBatchUploadAssets()                            — mutation POST /assets/upload (OPTIMISTIC)
  useRemoveAsset()                                  — mutation DELETE /assets/:id (OPTIMISTIC + cascade)
  downloadMediaItem(media, suggestedPrefix)         — utility / pure function (no cache)
```

#### Files that import from `@/features/media/api/mediaApi`:
1. `features/elements/hooks/useCreateElementForm.js` → `{ useBatchUploadAssets }`
2. `features/workflows/model/useMediaActions.js` → `{ useRemoveAsset }`
3. `features/assets/ui/LibraryMediaGridItem.jsx` — check imports (may also import like hook)
4. `widgets/ImportMediaDialog/*` — check (may use batch upload or inline fetch)
5. `widgets/EditNavbar/EditNavbar.jsx` — check for media download

Full contract confirm in Phase B.

---

### T4: `features/characters/hooks/useCharacter.js` (789 lines — MASTER HOOK)

#### Exports:
- **Named export**: `useCharacter({ projectId, characterId, workflowId })` — single massive hook, returns shape:
```
{
  characterWorkflows,                  — from useCharacterWorkflows (memo-filter)
  characters,                          — projectContents.characters[]
  workflows,                           — projectContents.workflows[]
  media,                               — projectContents.media[]
  sheetMedia,                          — derived: media where step_id==character_sheet + mediaId
  detailImages,                        — derived: media where step_id==character_detail + isLocalOrUploaded
  character,                           — selected character entity (by characterId / workflowId)
  characterWorkflow,                   — selected workflow where id matches
  mainMedia,                           — primary media item (first of sheetMedia[0])
  isLoading, isPendingProcessing,      — booleans
  refetch,                             — queryClient.invalidateQueries wrapper
  // Mutations (hooks wrapped + aliased)
  createCharacter: createCharacterMutation.mutate,
  createCharacterMutation,
  createCharacterAsync: createCharacterMutation.mutateAsync,
  isCreating: createCharacterMutation.isPending,
  updateCharacter,
  updateCharacterMutation,
  isUpdating,
  updateCharacterAsync,
  generateSheet: generateSheetMutation.mutate,
  generateSheetMutation,
  isGeneratingSheet,
  generateSheetAsync,
  setSheetMedia: setSheetMediaMutation.mutate,
  setSheetMediaMutation,
  isSettingSheetMedia,
  setSheetMediaAsync,
  addMedia: addMediaMutation.mutate,
  addMediaMutation,
  isAddingMedia,
  addMediaAsync,
  removeMedia: removeMediaMutation.mutate,
  removeMediaMutation,
  isRemovingMedia,
  removeMediaAsync,
  deleteCharacter,                     — useWorkflowDelete().deleteWorkflow() aliased
  deleteMutation,                      — useWorkflowDelete().deleteMutation
  isDeleting,                          — useWorkflowDelete().isDeleting
  generateDescription: generateDescriptionMutation.mutate,
  generateDescriptionMutation,
  isGeneratingDescription,
  // Local state (sheet upload preview + detail uploads, BUG: removeDetailImage has no rollback)
  optimisticSheetUrl,                  — useState + URL.createObjectURL preview
  addedDetailImages,                   — useState array of pre-upload local images
  uploadSheetFile,                     — handles optimistic blob + sets sheet mutation
  uploadDetailFiles,                   — handles optimistic addedDetailImages[] entries + triggers addMedia per file
  removeDetailImage,                   — removes locally before calling removeMediaMutation (BUG: no catch → rollback on API failure not done here)
  clearOptimisticSheet,
}
```

#### Files that import from `@/features/characters/hooks/useCharacter` (import contract):
- workflowsApi.js barrel re-exports → so any file importing from workflowsApi.js indirectly gets `useCharacter` through the barrel → need to keep barrel re-export `useCharacter` named identically.
- Additionally any direct importer: grep (none returned in first pass, but character page imports `useCharacter` from the barrel alias).

---

### T5: `features/elements/hooks/useElement.js` (561 lines — MASTER HOOK)

#### Exports:
- **Named exports**:
  1. `useElement({ projectId, elementId, workflowId })` — master hook, returns shape:
     ```
     {
       elementSheetWorkflows,              — useElementSheetWorkflows() return
       elements: projectContents.elements[],
       workflows, media,
       element,                            — selected element entity by elementId/workflowId
       elementWorkflow,
       mainMedia,
       refImages,                          — derived (where step_id in {CAE, CHARACTER_SHEET, UPLOAD, etc})
       isLoading, isPendingProcessing,
       refetch,
       createElementSheet, isCreating, createElementSheetMutation, createElementSheetAsync,
       updateMetadata: updateMetadataMutation.mutate, isUpdating, updateMetadataMutation, updateMetadataAsync,
       addImage: addImageMutation.mutate, isAddingImage, addImageMutation, addImageAsync,
       deleteImage: deleteMediaItemMutation.mutate, isDeletingImage, deleteMediaItemMutation, deleteImageAsync,
       analyzeVision, isAnalyzingVision, analyzeVisionMutation,
       analyzeVisionAsync,
       deleteElement, deleteMutation, isDeleting,  — useWorkflowDelete wrapped
     }
     ```
  2. **Separate named exports (NOT bundled inside master hook)**: `useCreateElementSheetMutation, useUpdateElementMetadata, useAddImageToElement, useDeleteMediaItem, useAnalyzeElementVision, useElementSheetWorkflows` — these are also exported directly (confirmed: workflowsApi.js barrel re-exports those names too).

#### Files that import from `@/features/elements/hooks/useElement`:
1. `widgets/NewElementDialog/NewElementDialog.jsx:24` → `{ useCreateElementSheetMutation }` (direct import — master file also exports this mutation hook named export, so barrel must keep named re-export with exactly that name).
2. Indirect: workflowsApi.js barrel re-exports all 6 element hooks + master useElement.

---

## 0.3 Helper locations (duplicated code candidates — move UNCHANGED in T-A1)

Candidate helpers to extract UNCHANGED into `features/workflows/lib/cacheHelpers.js`:
- `workflowsApi.js`: `const cleanId = id => String(id).replace(/^workflows\//, "")` (used inside useUpdateWorkflow onSuccess patch).
- `foldersApi.js`: inline ID strip `/^workflows\//` in `useMoveAssetToFolder.onMutate`.
- `foldersApi.js`: inline `folder_id`/`folderId`/`metadata.{folder_id,folderId}` patching (4 variants written together).
- `workflowsApi.js` `useToggleLike`: `m.id === itemId || m.name === itemId` dual match.
- `workflowsApi.js` `useRemoveWorkflow`: wf.id or wf.name match + strip prefix.

Shared utility file candidates:
- buildOptimistic* (3 functions) from `features/characters/services/characterService.js` (workflow/media/character). Those are used from useCharacter ONLY today so can stay there. If elements duplicates builders, extract then.

Note: AGENTS.md says "Refactors that move code are a separate task with their own commit". T-A1 is that commit.

---

## 0.4 Pre-existing warnings & known issues (NOT TO BE FIXED NOW)

- 20 ESLint warnings (no-unused-vars + exhaustive-deps). Leave as-is.
- `useMoveWorkflow()` returns `{ok:true}` without API call. Keep + report as dead.
- `useCharacter.removeDetailImage` local state: deletes image BEFORE the API call. If the API call fails it does NOT restore the entry. Do NOT fix; report.
- Console.* usage in several hooks/onError. Do NOT fix; report.
- `useWorkflowDelete.js` uses console.error. Do NOT fix; report.
- `characterService.js` uses console.error. Do NOT fix; report.
- `workflowsApi.js` `useAssets()` defined BOTH in workflowsApi.js AND mediaApi.js (duplicated export). Keep both + re-export for contract preservation.
- `normalizeProjectData` imported in workflowsApi.js l6 but unused → keep, no behavior change.

---

## 0.5 Manual smoke checklist (reported after final phase; not part of gates today)

- Drag-drop workflow onto collection card → workflow leaves root grid instantly → appears in collection detail instantly.
- Delete workflow via context menu (batch) → grids update instantly.
- Heart icon click (media like + workflow favorite) → heart flips instantly.
- Inline rename folder/collection → text updates instantly.
- Create character sheet dialog → optimistically inserts workflow card instantly.
- Create element dialog → same.
- Import media → uploads appear as uploading instantly with blob preview.

All these flows should behave byte identical after refactor. If any feels different = diffing bug, must revert before next phase.
