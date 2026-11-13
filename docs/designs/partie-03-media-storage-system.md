# Partie 03 Design: System 4 — Media & Storage (`src/systems/media/`)

## 1. System Objective
System 4 (`media`) encapsulates all storage providers (Supabase Storage, InMemory), asset/media file ingestion & metadata inspection (`sharp`), file save types / retention policies, and media database tables (`media`, `workflow_media`).
Crucially, it encapsulates and eliminates the #1 God Node in the architecture graph: `WorkflowMediaRepository` (52 incoming edges), replacing direct table access across characters, elements, workflows, and trash with clean, strongly-typed DTO tools.

## 2. Gateways & Package Aliases
- `#media/api` -> `./src/systems/media/public/api.js`
- `#media/tools` -> `./src/systems/media/public/tools.js`

### 2.1 Public HTTP API (`public/api.js`)
- `POST /api/assets/upload` (and `POST /api/media/upload`, `POST /api/media/ingest`)
- `GET /api/media/:id`
- `DELETE /api/media/:id` and `DELETE /api/assets/:id`
- `PATCH /api/assets/:assetId/folder`
- Re-exports router for mounting in `src/api/routes.js` and legacy `routes/assets.js`, `routes/mediaIngestRoutes.js`.

### 2.2 Public Tools (`public/tools.js`)
Exposes plain DTO functions for other systems:
- `createPendingMedia({ userId, workflowId, saveType, role, ... })` -> returns `{ mediaId, ... }`
- `persistExternalMedia({ mediaId, sourceUrl, metadata, ... })`
- `markMediaFailed({ mediaId, errorCode, ... })`
- `linkMediaToEntity({ mediaId, entityType, entityId, role, ... })`
- `getMediaUrls(mediaIds)`
- `deleteMedia({ mediaId, userId, ... })`
- `uploadAsset(...)` / `createUploadMiddleware`
- `getStorageService()` / `getMediaService()` / `getWorkflowMediaRepository()` / `getMediaRepository()` facades ensuring backward compatibility.

## 3. Internal Architecture (`src/systems/media/internal/`)
```
src/systems/media/
├── public/
│   ├── api.js           # Express HTTP Gateway (R1, R3, R4, R13)
│   └── tools.js         # Inter-system Tools Gateway (DTOs only, R1, R8)
├── internal/
│   ├── saveTypes.js     # Declarative SaveTypeRegistry (Rule 11)
│   ├── errors.js        # System-prefixed errors (MediaError, MediaStorageError, etc.)
│   ├── storage/         # Cloud storage providers & abstraction (Rule 6, Rule 12)
│   │   ├── IStorageProvider.js
│   │   ├── StorageService.js
│   │   ├── StoragePathResolver.js
│   │   ├── storageFactory.js
│   │   ├── streamUtils.js
│   │   ├── StorageErrors.js
│   │   └── providers/
│   │       ├── SupabaseStorageProvider.js
│   │       └── InMemoryStorageProvider.js
│   ├── db/              # Exclusive owner of media and workflow_media tables (Rule 5, Rule 12)
│   │   ├── mediaClient.js
│   │   ├── MediaRepository.js
│   │   ├── WorkflowMediaRepository.js
│   │   ├── workflowMediaLinker.js
│   │   ├── workflowMediaOps.js
│   │   └── workflowMediaRole.js
│   ├── ingestion/       # Image inspection, policy, and upload pipeline
│   │   ├── MediaInspector.js
│   │   ├── SourceReader.js
│   │   ├── SourceResolver.js
│   │   ├── SourcePolicy.js
│   │   ├── UploadPolicy.js
│   │   ├── MediaUploadErrors.js
│   │   ├── MediaUploadService.js
│   │   └── AssetUploadService.js
│   └── services/        # Business logic & lifecycle
│       ├── MediaService.js
│       ├── MediaLifecycleService.js
│       └── mediaMetadataResolver.js
```

## 4. Architectural Rules Compliance
- **Rule 6 & Rule 12**: Database clients (`supabase`) are strictly confined to `internal/db/` and `internal/storage/`.
- **Rule 13**: `express` and `multer` are strictly confined to `public/api.js`.
- **Rule 7 & Rule 11**: `internal/` files never import `public/api.js` or `public/tools.js`.
- **Rule 8**: `public/tools.js` functions accept and return pure DTOs (plain objects/primitives).
- **Rule 15**: `package.json#imports` only exposes `#media/api` and `#media/tools`.
- **Backward Compatibility**: `src/platform/storage/*`, `src/platform/media-ingestion/*`, `src/platform/media/*`, `src/db/MediaRepository.js`, `src/db/WorkflowMediaRepository.js`, `routes/assets.js`, `routes/mediaIngestRoutes.js` re-export from `src/systems/media/`.

## 5. Tickets
- **Ticket 3.1**: Save-Type Registry & Storage Provider Abstraction (`internal/saveTypes.js`, `internal/storage/`).
- **Ticket 3.2**: Media DB Layer (`internal/db/MediaRepository.js`, `WorkflowMediaRepository.js`, etc.).
- **Ticket 3.3**: Ingestion, Inspection & Lifecycle Services (`internal/ingestion/`, `internal/services/`).
- **Ticket 3.4**: System Errors, Public Gateways (`public/api.js`, `public/tools.js`), Package Imports, Legacy Re-exports & Unit Tests.
