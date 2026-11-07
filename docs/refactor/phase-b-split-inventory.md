# T-B1 / T-B4: Folder + Media Split Inventory (Phase B)
Plan: hooks-split-plan.md — Phase B (folders: 211 lines → 6 files + media: 400 lines → 8 files).

Rules for both:
- Shims FIRST: foldersApi.js / mediaApi.js → 1-line `export *` from new paths.
- Split files: copy export VERBATIM. Same function name, same signature, same import dependencies local to each file.
- 0 behavior changes. No signature changes. No new options. No new error messages.
- Shared deps stay identical (React Query imports, `@/shared/api/client`, `queryKeys`, local helpers).
- If a split file needs a Phase-A helper (`stripWorkflowPrefix`, `matchMediaId`) it imports DIRECTLY from `@/features/workflows/lib/cacheHelpers` (NOT through the old barrel).
- Barrel `features/folders/index.js` stays EXACTLY `export * from "./api/foldersApi"` (still points at shim = backward compat for all 3 current consumers of the barrel: `features/folders` importers → MediaGridItem, StudioNavbarLeft, Collection page).
- Barrel `features/media/index.js`: keeps existing exports AND `export * from "./api/mediaApi"` → shimmed transparently.

---

## PART 1: Folders split (5 named exports → 5 files + 1 shim = 6 files)

foldersApi.js TODAY: 126 lines (NOT 211 — after audit revert from Phase A fixup shrunk from 211 → 126; still exactly 5 named hooks, 1 query + 4 mutations). Split anyway per plan (the intent: 1 hook per file for Phase C/D dependency isolation).

| File path (NEW) | Export | Lines | Deps inside split file |
|---|---|---:|---|
| `features/folders/queries/useProjectFolders.js` | `useProjectFolders(projectId)` | 21 | `useQuery` + `api` + `queryKeys` |
| `features/folders/mutations/useCreateFolder.js` | `useCreateFolder()` | 25 | `useMutation`, `useQueryClient` + `api`, `queryKeys` |
| `features/folders/mutations/useUpdateFolder.js` | `useUpdateFolder()` | 20 | `useMutation`, `useQueryClient` + `api`, `queryKeys` |
| `features/folders/mutations/useDeleteFolder.js` | `useDeleteFolder()` | 20 | `useMutation`, `useQueryClient` + `api`, `queryKeys` |
| `features/folders/mutations/useMoveAssetToFolder.js` | `useMoveAssetToFolder()` | 22 | `useMutation`, `useQueryClient` + `api`, `queryKeys` |
| `features/folders/api/foldersApi.js` (SHIM) | Re-export 5 hooks | 8 | 5 `export {…}` statements |

Total new split files: **5** + shim rewrite of existing foldersApi.js (counted as file #6 in plan → total 6). ✅ Matches plan count.

Folders barrel: NO CHANGE — keeps `export * from "./api/foldersApi"` → resolves via shim → all 5 current importers continue to work from `@/features/folders` OR `@/features/folders/api/foldersApi` OR relative `../foldersApi` (none use relative; all import from `@/features/folders` barrel). Already verified by grep in pre-Phase-B check.

---

## PART 2: Media split (inventory: count actual exports in mediaApi.js)

Run inline in next step (T-B4). This file is larger (~400 lines). Target: 8 files per plan. The inventory will be written once mediaApi.js is read.
