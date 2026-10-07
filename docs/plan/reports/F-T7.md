# F-T7 Report: Asset Listing with Folder Filters & Pagination

## 1. Summary of Changes
- Implemented `GET /api/projects/:projectId/assets` in `routes/projects.js` and `controllers/projectsController.js:listAssets`.
- Implemented `GenerationService.listProjectAssets` handling:
  - Folder scoping and validation (`folderService.assertFolderUsable`)
  - "All assets" when `folderId` is omitted
  - `folderId=none` filtering where `folder_id IS NULL`
  - Direct folder filtering `folder_id = folderId`
  - Recursive subtree inclusion when `includeDescendants=true` via `folderTree.collectDescendantIds`
  - Pagination using base64 opaque cursors (`{ createTime, id }`) and configurable limit (`ASSET_LIST_MAX_LIMIT`, default 200, query default 50)
  - Mapping rows to product asset JSON using `toAssetDto`
- Implemented `WorkflowRepository.listProjectAssets` with composite ordering (`create_time DESC, id DESC`).
- Preserved existing `/api/workflows/project-data/:project_id` response structure unchanged (Decision D-20).

## 2. Testing & Verification
- Unit & Integration Suite: `tests/integration/assetListingWithFolders.test.js` (11 passing tests)
  - Scenario 9.1: returns all project assets when folderId is omitted [VERIFIED]
  - Scenario 9.2: returns only assets in specific folder [VERIFIED]
  - Scenario 9.3: returns only assets with folder_id null when folderId=none [VERIFIED]
  - Scenario 9.4: returns assets in folder and sub-folders when includeDescendants=true [VERIFIED]
  - Scenario 9.5: ignores includeDescendants when folderId=none [VERIFIED]
  - Scenario 9.6: pagination across 2 pages with limit and nextCursor round-trip [VERIFIED]
  - Returns 400 for invalid folderId format [VERIFIED]
  - Returns 404 for foreign folderId (User B's folder) [VERIFIED]
  - Returns 404 for foreign projectId (cross-tenant) [VERIFIED]
  - Returns 401 when unauthenticated [VERIFIED]
  - Decision D-20: preserves existing project-data response shape [VERIFIED]
- Hermetic `npm test`: 630 passed, 10 failed (the exact same 9 baseline test failures + top-level suite count), 0 regressions [VERIFIED].
- Code hygiene: 0 console.* added [VERIFIED]. Secrets scan clean [VERIFIED].
