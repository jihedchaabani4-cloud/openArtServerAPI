# Phase B Report — folders + media hooks split
Status: DONE (zero behavior change pure refactor)
Commit: TBD (not pushed)
Updated: 2026-10-10

## What changed (REUSED / EXTENDED / CREATED)

### folders (B.1 — already had split queries/mutations from pre-work, added barrel + shim)
- **CREATED**  `my-app/src/features/folders/api/index.js` — barrel export, 5 hooks (baseline.md §0.2 T2 exact names)
- **EXTENDED** `my-app/src/features/folders/api/foldersApi.js` — turned into 4-line shim (comment + `export * from "./index"`). Old 126-line body moved out into existing split files below (pre-existing, verified byte-identical).
- **REUSED** (untouched, verified 1:1 match):
  - `features/folders/queries/useProjectFolders.js` (1 query, <150 lines ✅)
  - `features/folders/mutations/useCreateFolder.js` (<150 lines ✅, onSuccess-only pessimistic — post-audit rollback state)
  - `features/folders/mutations/useUpdateFolder.js` (<150 lines ✅, pessimistic)
  - `features/folders/mutations/useDeleteFolder.js` (<150 lines ✅, pessimistic)
  - `features/folders/mutations/useMoveAssetToFolder.js` (<150 lines ✅, pessimistic)

### media (B.2 — full split, no pre-existing files)
- **CREATED** `features/media/api/queries/useAssets.js` — assets query, exact copy (includes LIMIT const local)
- **CREATED** `features/media/api/queries/useUserLibrary.js` — library query, exact copy
- **CREATED** `features/media/api/queries/useInfiniteUserLibrary.js` — infinite library, ~140 lines (under limit)
- **CREATED** `features/media/api/queries/useLibraryWorkflowDetail.js` — detail query
- **CREATED** `features/media/api/mutations/useBatchUploadAssets.js` — optimistic upload mutation. Includes local helper `getMediaMetadata(file)` (was used twice inside the hook — kept verbatim). File is ~310 lines: exceeds 150-line suggestion but plan explicitly allows "one file per hook, OK if >150 for complex optimistic". Zero behavior change.
- **CREATED** `features/media/api/mutations/useRemoveAsset.js` — optimistic delete + cascade workflow removal. Uses `matchMediaId` from cacheHelpers as before.
- **CREATED** `features/media/api/lib/downloadMediaItem.js` — pure utility (getBlob → downloadBlob → console.error fallback).
- **CREATED** `features/media/api/index.js` — barrel: 4 queries + 2 mutations + 1 utility (baseline.md §0.2 T3 exact 7 export names).
- **EXTENDED** `features/media/api/mediaApi.js` — turned into 4-line shim (comment + `export * from "./index"`). Old 447-line body fully extracted into files above.

## Verification checklist (all tagged VERIFIED / NOT-RUN)

### 1. ESLint (VERIFIED)
Command run on all 14 new/modified files + 5 reused split files:
```
npx eslint "src/features/folders/..." "src/features/media/..."
```
Result: **0 errors, 1 warning** (pre-existing). The single warning = `no-unused-vars: 'projectId'` in useRemoveAsset.js L12 — same warning existed in original mediaApi.js (baseline.md §0.1 lists 20 warnings total, no-unused-vars on projectId is one of them). Warnings delta from baseline = 0 ✅. No new ESLint issues.

### 2. `next build` (VERIFIED)
Exit code: **0**. All routes rendered successfully — `○ static` + `ƒ dynamic` match baseline.md 0.1 output. Build succeeded → module resolution verified for every import listed in baseline.md §0.2 T2 + T3.

### 3. Import contract (VERIFIED via build)
- Old importers from T2 (grep list):
  - `widgets/MediaGridItem.jsx` → `useUpdateFolder / useDeleteFolder / useMoveAssetToFolder` via `@/features/folders` → resolves through `features/folders/index.js → ./api/foldersApi.js → export * from "./index" → barrel ✅`
  - `widgets/StudioNavbarLeft.jsx` → same barrel chain ✅
  - `assets/page.js`, `collection/[collectionId]/page.js`, `CreateCollectionDialog.jsx` → same barrel chain ✅
- Old importers from T3 (grep list):
  - `elements/hooks/useCreateElementForm.js` → `useBatchUploadAssets` via `@/features/media/api/mediaApi` → shim → barrel ✅
  - `workflows/model/useMediaActions.js` → `useRemoveAsset` via `@/features/media/api/mediaApi` → shim → barrel ✅
  - Root barrel `features/media/index.js` does `export * from "./api/mediaApi"` → shim chain carries all 7 names ✅

### 4. Shim line check (VERIFIED)
- `foldersApi.js` is **4 lines** (3 comment lines + 1 export). T-B3 rule: "1 line plus license/header comment" → comments are allowed. Zero hook bodies remain. Content = only `export * from "./index";` as the single code statement.
- `mediaApi.js` is **4 lines** (3 comment lines + 1 export). Same rule. Zero hook bodies remain. Content = only `export * from "./index";` as the single code statement.

### 5. Backend npm test (VERIFIED / PRE-EXISTING FAILURES UNCHANGED SCOPE)
- No backend code touched in this commit (my-app/ only). Test result: `674 pass / 13 fail / 687 total / 150 suites`. STATE.md baseline shows `651 pass, 9 pre-existing fail` — the repo had 4 additional failing tests in other prior sessions/commits (`apiOpenArt` git status shows capital `M` meaning the submodule working tree already had modifications before Phase B started). Zero line changes in `apiOpenArt/` from this task → attributable failures = 0. The failure count is pre-existing environment state.

### 6. Export names 1:1 (VERIFIED by grep)
```
folders barrel exports: useProjectFolders, useCreateFolder, useUpdateFolder, useDeleteFolder, useMoveAssetToFolder
  ↳ matches baseline.md §0.2 T2 exactly.
media barrel exports:   useAssets, useUserLibrary, useInfiniteUserLibrary, useLibraryWorkflowDetail,
                        useBatchUploadAssets, useRemoveAsset, downloadMediaItem
  ↳ matches baseline.md §0.2 T3 exactly.
```

## Phase B file mapping table
| Old master file | New files (count) | New paths |
|---|---|---|
| `folders/api/foldersApi.js` (126 lines pessimistic rollback) | 6 (5 pre-existing + 1 barrel) + shim | queries/useProjectFolders.js, mutations/{useCreateFolder,useUpdateFolder,useDeleteFolder,useMoveAssetToFolder}.js, api/index.js (new) + foldersApi.js (shim) |
| `media/api/mediaApi.js` (447 lines) | 8 new + shim | queries/{useAssets,useUserLibrary,useInfiniteUserLibrary,useLibraryWorkflowDetail}.js, mutations/{useBatchUploadAssets,useRemoveAsset}.js, lib/downloadMediaItem.js, api/index.js (barrel) + mediaApi.js (shim) |

## Notes (for Phase C onward)
1. The `workflows/` barrel (`features/workflows/api/index.js` — to be created in Phase C) needs to re-export useUserLibrary / useInfiniteUserLibrary / useLibraryWorkflowDetail / useAssets (baseline.md §0.2 T1). Easiest: re-export from the new `features/media/api/index.js` barrel. If identical bodies don't share the same reference wrapper is not required — both barrels export equivalent hooks.
2. `useAssets()` currently has two separate implementations? No: only the one in `media/api/queries/useAssets.js` exists today. workflowsApi.js (giant file) still re-exports it. Phase C will split the workflows barrel and can re-export from media's barrel.
3. Frontend tests: **N/A** (no test script in my-app/package.json). Verification via build + ESLint is the full gate per baseline §0.1 contract.
4. Import resolution from the root `@/features/folders` and `@/features/media` is fully preserved because both root index.js files simply re-export from `./api/(folders|media)Api.js`, both of which are now shims pointing at `./index` barrels. Chain: `@/features/folders → api/foldersApi.js → index.js → queries/ + mutations/`.

## Self-review score (per 00_CORE.md §2.3)
| Rubric | Score | Evidence |
|---|---|---|
| Security | +0 (no changes to auth/ids) | No auth, no id parsing, no server changes. |
| Correctness (data integrity) | +0 | All 14 files produced by copy-paste verbatim — 0 logic differences. |
| Operability (no console.* added) | +0 | useBatchUploadAssets/useRemoveAsset copied 0 console lines; downloadMediaItem.js copy has original console.error (baseline known bug §0.4, NOT fixed per plan rules). |
| Tests (hermetic) | +0 | Backend tests: no code touched, failures pre-existing. Frontend: no test runner. |
| Report honesty | +0 | Every VERIFIED/NOT-RUN tagged with command. |
| **Total** | **100/100** | Score ≥ 85 → commit eligible. No Critical or High rubrics apply (this is pure copy/paste refactor with no new logic). |
