# SES0: Assets and Folders Model Audit Report

Status: DONE
Audit ID: SES0
Commit: (staged with this audit)
Evidence tag convention: VERIFIED / INFERRED / NOT-RUN

---

## 1. Scope

Comprehensive read-only audit of the existing assets, workflows, media, projects, elements, and characters data model and service layers in the backend codebase. The purpose is to verify the central data model hypothesis (whether `workflow` represents an asset item and `media` represents its files/versions), map all real table and column names, inspect existing grouping/folder mechanisms, analyze project scoping and ownership rules, and decide definitively between Path A and Path B for Phase P3 (Folders implementation).

---

## 2. Method

Searches and inspections executed:
- `git ls-files | rg -i "migration|schema|\.sql$"` — identified all migration files and base schema (`database_schema.sql`).
- `rg -n "CREATE TABLE" database_schema.sql migrations/` — identified all table definitions.
- Inspection of `database_schema.sql` (lines 70–180, 280–360, 480–525, 600–637) — extracted schemas for `project`, `session`, `workflow`, `media`, `profiles`, `wallets`, `transactions`, `characters`.
- Inspection of `migrations/20260720_create_element_table.sql` and subsequent element migrations — extracted `public.element` schema.
- Inspection of `migrations/create_workflow_with_placeholder_media.sql` — verified atomic workflow + media creation RPC.
- Inspection of `src/db/WorkflowRepository.js` and `src/db/MediaRepository.js` — verified data access methods (`createWorkflow`, `updatePrimaryMedia`, `findByProject`, `findByProjectsPaginated`, `appendMediaToWorkflow`, etc.).
- Inspection of `src/domain/generation/GenerationService.js`, `src/domain/project/ProjectReadService.js`, and `src/v2/services/v1StorageBridge.js` — verified how items and version edits are assembled and queried.
- Inspection of `routes/assets.js`, `routes/workflows.js`, `routes/projects.js`, `routes/characters.js`, `routes/elementRoutes.js`, `routes/images.js`, and `controllers/` — mapped existing HTTP API endpoints.
- Inspection of `src/platform/security/ownership.js` — verified `assertOwns` implementation, queries, and 404 error semantics.

---

## 3. Data Model Mapping (Step 1)

| Concept | Real Table | Columns (Name, Type, Nullable) | Foreign Keys & Constraints |
|---|---|---|---|
| **Project** | `public.project` | `id` (uuid, NOT NULL, PK)<br>`project_name` (text, NOT NULL)<br>`create_time` (timestamptz, NOT NULL, DEFAULT now())<br>`user_id` (uuid, NULLABLE) | `project_pkey` (PRIMARY KEY id)<br>Referenced by `workflow`, `media`, `session`, `characters`. |
| **Workflow** (Logical Asset) | `public.workflow` | `id` (uuid, NOT NULL, PK)<br>`project_id` (uuid, NOT NULL)<br>`session_id` (uuid, NULLABLE)<br>`display_name` (text, NOT NULL)<br>`variation_index` (smallint, NULLABLE)<br>`primary_media_id` (uuid, NULLABLE)<br>`create_time` (timestamptz, NOT NULL, DEFAULT now())<br>`favorited` (boolean, DEFAULT false)<br>`workflow_type` (workflow_type enum, NOT NULL, DEFAULT 'GENERATION') | `workflow_pkey` (PRIMARY KEY id)<br>`workflow_project_id_fkey` (`project_id` REFERENCES `project(id)` ON DELETE CASCADE)<br>`workflow_session_id_fkey` (`session_id` REFERENCES `session(id)` ON DELETE SET NULL)<br>`fk_workflow_primary_media` (`primary_media_id` REFERENCES `media(id)` ON DELETE SET NULL)<br>CHECK (`variation_index >= 0`) |
| **Media** (File / Version) | `public.media` | `id` (uuid, NOT NULL, PK)<br>`workflow_id` (uuid, NOT NULL)<br>`project_id` (uuid, NOT NULL)<br>`generation_config_id` (uuid, NULLABLE)<br>`step_id` (text, NOT NULL)<br>`url` (text, NULLABLE)<br>`width` (integer, NOT NULL, CHECK > 0)<br>`height` (integer, NOT NULL, CHECK > 0)<br>`create_time` (timestamptz, NOT NULL, DEFAULT now())<br>`status` (media_status enum, DEFAULT 'processing')<br>`error_message` (text, NULLABLE) | `media_pkey` (PRIMARY KEY id)<br>`media_workflow_id_fkey` (`workflow_id` REFERENCES `workflow(id)` ON DELETE CASCADE)<br>`media_project_id_fkey` (`project_id` REFERENCES `project(id)` ON DELETE CASCADE)<br>`media_generation_config_id_fkey` (`generation_config_id` REFERENCES `generation_config(id)` ON DELETE SET NULL) |
| **Session** (Flat Section) | `public.session` | `id` (uuid, NOT NULL, PK)<br>`project_id` (uuid, NOT NULL)<br>`name` (text, NOT NULL)<br>`position` (smallint, NOT NULL DEFAULT 0)<br>`create_time` (timestamptz, NOT NULL DEFAULT now()) | `session_pkey` (PRIMARY KEY id)<br>`session_project_id_fkey` (`project_id` REFERENCES `project(id)` ON DELETE CASCADE) |
| **Element** | `public.element` | `id` (uuid, NOT NULL, PK)<br>`workflow_id` (uuid, NOT NULL)<br>`generation_config_id` (uuid, NULLABLE)<br>`primary_media_id` (uuid, NULLABLE)<br>`name` (text, NOT NULL)<br>`category` (text, NOT NULL DEFAULT 'Product')<br>`description` (text, NULLABLE)<br>`master_identity` (text, NULLABLE)<br>`consistency_rules` (jsonb, NOT NULL DEFAULT '[]')<br>`source_images` (jsonb, NOT NULL DEFAULT '[]')<br>`guidelines` (text, DEFAULT '')<br>`version` (int, NOT NULL DEFAULT 1)<br>`create_time` (timestamptz, NOT NULL DEFAULT now()) | `element_pkey` (PRIMARY KEY id)<br>`element_workflow_id_fkey` (`workflow_id` REFERENCES `workflow(id)` ON DELETE CASCADE)<br>`element_generation_config_id_fkey` (`generation_config_id` REFERENCES `generation_config(id)` ON DELETE CASCADE)<br>`element_primary_media_id_fkey` (`primary_media_id` REFERENCES `media(id)` ON DELETE SET NULL) |
| **Character** | `public.characters` | `id` (uuid, NOT NULL, PK)<br>`user_id` (uuid, NOT NULL)<br>`project_id` (uuid, NULLABLE)<br>`workflow_id` (uuid, NULLABLE)<br>`name` (varchar(255), NOT NULL)<br>`title` (varchar(255), NULLABLE)<br>`description` (text, NULLABLE)<br>`character_info` (text, NULLABLE)<br>`archetype` (varchar(100), NULLABLE)<br>`gender` (varchar(50), NULLABLE)<br>`style` (varchar(100), DEFAULT 'cinematic')<br>`traits` (jsonb, DEFAULT '{}')<br>`keywords` (text[], DEFAULT '{}')<br>`guidelines` (text[], DEFAULT '{}')<br>`avatar_url` (text, NULLABLE)<br>`turnaround_url` (text, NULLABLE)<br>`reference_images` (text[], DEFAULT '{}')<br>`is_favorited` (boolean, DEFAULT false)<br>`status` (varchar(50), DEFAULT 'ready')<br>`created_at` (timestamptz, DEFAULT now())<br>`updated_at` (timestamptz, DEFAULT now()) | `characters_pkey` (PRIMARY KEY id)<br>`characters_project_id_fkey` (`project_id` REFERENCES `project(id)` ON DELETE CASCADE)<br>`characters_user_id_fkey` (`user_id` REFERENCES `auth.users(id)` ON DELETE CASCADE)<br>`characters_workflow_id_fkey` (`workflow_id` REFERENCES `workflow(id)` ON DELETE SET NULL) |
| **User / Profile** | `public.profiles` | `id` (uuid, NOT NULL, PK)<br>`email` (text, NULLABLE)<br>`full_name` (text, NULLABLE)<br>`avatar_url` (text, NULLABLE)<br>`created_at` (timestamptz, DEFAULT now())<br>`credits` (integer, DEFAULT 0, deprecated) | `profiles_pkey` (PRIMARY KEY id)<br>`profiles_id_fkey` (`id` REFERENCES `auth.users(id)` ON DELETE CASCADE) |
| **Wallet / Credits** | `public.wallets` | `id` (uuid, NOT NULL, PK)<br>`user_id` (uuid, NOT NULL, UNIQUE)<br>`balance` (numeric, DEFAULT 0.00, CHECK >= 0)<br>`updated_at` (timestamptz, DEFAULT now()) | `wallets_pkey` (PRIMARY KEY id)<br>`fk_wallets_user` (`user_id` REFERENCES `auth.users(id)` ON DELETE CASCADE) |
| **Transactions** | `public.transactions` | `id` (uuid, NOT NULL, PK)<br>`wallet_id` (uuid, NOT NULL)<br>`amount` (numeric, NOT NULL)<br>`type` (transaction_type enum, NOT NULL)<br>`status` (transaction_status enum, DEFAULT 'PENDING')<br>`reference_id` (varchar, NOT NULL, UNIQUE)<br>`metadata` (jsonb, DEFAULT '{}')<br>`expires_at` (timestamptz, NOT NULL)<br>`created_at` (timestamptz, DEFAULT now())<br>`updated_at` (timestamptz, DEFAULT now()) | `transactions_pkey` (PRIMARY KEY id)<br>`transactions_wallet_id_fkey` (`wallet_id` REFERENCES `wallets(id)` ON DELETE CASCADE) |

---

## 4. Central Hypothesis Verification (Step 2)

**Hypothesis:** A `workflow` row = an asset; a `media` row = a version of that asset; the 'primary media' (`updatePrimaryMedia`) = the current version.

- **a. Is one workflow row created for each generation/upload that a user sees as an "item"?**
  - **VERIFIED:** Yes. Each image generation creates one `workflow` record (`controllers/imageController.js:132-135`), each video generation creates one `workflow` record (`controllers/videoController.js:140-150`), and each direct upload creates an `UPLOAD` `workflow` record (`src/platform/media-ingestion/MediaIngestionService.js:304-311`). In user-facing library listings, `GenerationService.getUserLibrary` paginates over `workflow` records (`src/domain/generation/GenerationService.js:213-225`).
- **b. Do media rows reference a workflow id (a foreign key)? Can one workflow have several media rows? Is one of them marked primary?**
  - **VERIFIED:** Yes. `public.media.workflow_id` is a foreign key referencing `public.workflow.id` ON DELETE CASCADE (`database_schema.sql:168-169`). Multiple `media` rows reference the same `workflow_id` (`src/db/MediaRepository.js:35-43 findByWorkflow`). The primary version is stored on `public.workflow.primary_media_id` referencing `public.media.id` (`database_schema.sql:127-128`, `src/db/WorkflowRepository.js:58-64 updatePrimaryMedia`).
- **c. When the user re-generates or edits, is a NEW media row added to the same workflow (version-like), or a NEW workflow row?**
  - **VERIFIED:** For edits/transformations, a NEW `media` row is appended to the EXISTING `workflow` with `step_id: "EDIT"` via `appendPlaceholderToWorkflow` (`src/v2/services/v1StorageBridge.js:175-180`, `src/db/workflowMediaOps.js:122-137`), and `workflow.primary_media_id` is updated to the newly appended media row (`src/db/workflowMediaOps.js:133`). For brand-new standalone generations, a new `workflow` row is created.
- **d. Which table does the "list items of a project" query use?**
  - **VERIFIED:** Both queries exist:
    1. `GenerationService.getUserLibrary` queries `public.workflow` (`WorkflowRepository.findByProjectsPaginated`, `src/domain/generation/GenerationService.js:213-217`) and resolves the `primary_media` row for each workflow.
    2. `ProjectReadService.getProjectData` queries `public.workflow` (`WorkflowRepository.findByProject`, `src/domain/project/ProjectReadService.js:90-98`) and formats workflows as the primary canvas/library items (`src/domain/project/ProjectReadService.js:184-205`), while also returning child `media` items (`src/domain/project/ProjectReadService.js:100-115`).
    3. `GenerationService.getAssets` provides a media-level query (`MediaRepository.findByProjectPaginated`, `src/domain/generation/GenerationService.js:188-190`).
    Thus, `workflow` is the conceptual asset item, with `media` acting as the file/version.
- **e. Do both tables carry `user_id` and `project_id`? Which of these are nullable?**
  - **VERIFIED:**
    - `public.workflow`: carries `project_id` (`uuid NOT NULL`). It does NOT carry `user_id` (ownership is inherited from `public.project.user_id`).
    - `public.media`: carries `project_id` (`uuid NOT NULL`) and `workflow_id` (`uuid NOT NULL`). It does NOT carry `user_id`.

**Verdict Rule:** **CONFIRMED** (points a, b, c, d all confirm `workflow` as the user-visible item and `media` as its files/versions).

---

## 5. Other Specific Questions (Step 3)

### 1. Existing folders / collections / groupings
- **VERIFIED:** `rg -n -i "folder|collection|group|album" src/ lib/ migrations/` reveals:
  - No database table, column, or route exists for folders or collections.
  - "folder" appears only as storage path prefixes (`src/platform/storage/StoragePathResolver.js:44`, `src/platform/media-ingestion/MediaIngestionService.js:225`) and compiler graph groupings (`src/v2/compiler/compileWorkflow.js:14`).
  - An unused mock branch for `"collection_item"` exists in `src/platform/security/ownership.js:194-204`, but no underlying table exists.
  - The only existing logical grouping in the database is `public.session` (flat sections inside a project with `name` and integer `position`, non-nested).

### 2. Routes listing a project's items today, pagination and filters
- **VERIFIED:**
  - `GET /api/workflows/library` (`routes/workflows.js:12` -> `generationsQueryController.getUserLibrary` -> `GenerationService.getUserLibrary`): queries `workflow` table with `project_id` (optional), `session_id` (optional), `limit` (default 30, max 100), `offset` (default 0). Returns `{ data, total, hasMore }`.
  - `GET /api/workflows/project-data/:project_id` (`routes/workflows.js:15` -> `projectController.getProjectData` -> `ProjectReadService.getProjectData`): unpaginated full project dump returning `{ projectName, projectId, sessions, workflows, media, elements }`.
  - `GET /api/workflows/assets/:project_id` (`routes/workflows.js:14` -> `generationsQueryController.getAssets` -> `GenerationService.getAssets`): queries `media` table with `project_id` param, `session_id` (optional query), `limit` (default 30), `offset` (default 0). Returns `{ data, hasMore }`.

### 3. Generation and upload parameters, required `projectId`
- **VERIFIED:**
  - `POST /api/images/generated` (`controllers/imageController.js:42, 58-60`): `project_id` is strictly REQUIRED. Request returns 400 (`project_id is required`) if omitted.
  - `POST /api/video/generated` (`controllers/videoController.js:41, 57-59`): `project_id` is strictly REQUIRED. Returns 400 (`project_id is required`) if omitted.
  - `POST /api/assets/upload` (`routes/assets.js:45` -> `MediaIngestionService.ingest`): accepts optional `project_id`. If omitted, `MediaIngestionService.js:291-300` falls back to the user's most recent project (`db.projects.client().from("project").select("id").eq("user_id", userId).order("create_time", { ascending: false }).limit(1)`).
  - Can generations happen without a project? No. The DB schema enforces `workflow.project_id NOT NULL` (`database_schema.sql:113`), and image/video generation controllers reject requests without `project_id`.

### 4. Characters and Elements services, tables, routes, and image links
- **VERIFIED:**
  - **Characters:**
    - Table: `public.characters` (`database_schema.sql:606-632`).
    - Service: `CharacterService.js`, `CharacterMediaService.js`, `CharacterRepository.js`.
    - Routes: `routes/characters.js` (`POST /api/characters/create`, `PATCH /api/characters/:characterId`, `POST /api/characters/:characterId/media`, `POST /api/characters/:characterId/sheet-media`).
    - Image links: Direct URL text strings on `avatar_url`, `turnaround_url`, and `reference_images text[]`. In addition, dedicated detail/sheet media are created as `media` records linked via `character.workflow_id` (`step_id: "character_detail"` or `"character_sheet"`).
  - **Elements:**
    - Table: `public.element` (`migrations/20260720_create_element_table.sql:3-28`).
    - Service: `ElementService.js`, `ElementMediaService.js`, `ElementRepository.js`.
    - Routes: `routes/elementRoutes.js` (`POST /api/v2/elements`, `GET /api/v2/elements/project/:projectId`, `GET /api/v2/elements/:id`, `POST /api/v2/elements/:id/images`, `DELETE /api/v2/elements/:id/images/:mediaId`).
    - Image links: `primary_media_id` FK to `public.media(id)`; `source_images` JSONB storing image reference payloads; `workflow_id` FK to `public.workflow(id)`. Element detail reference images are stored as `media` rows under `workflow_id` (`step_id: "element_reference"`).

### 5. Migration tooling, DB engine, and RLS
- **VERIFIED:**
  - Location: `migrations/` at the root of `apiOpenArt`.
  - Naming schemes: Sequential numbered (`003_...`, `006_...`, `007_...`) and date-prefixed (`20260720_...`, `20260925_...`).
  - Application mechanism: Manual execution in Supabase SQL editor (no automated migration runner CLI in `package.json`).
  - DB Engine: PostgreSQL (Supabase).
  - Row Level Security (RLS): Enabled on core tables (`database_schema.sql:484-493`). Policies enforce user ownership either via `user_id = auth.uid()` (`project`, `v2_workflow_runs`, `wallets`) or via project relation `project_id IN (SELECT id FROM public.project WHERE user_id = auth.uid())` (`session`, `workflow`, `media`).

### 6. `assertOwns("project")` implementation and failure response
- **VERIFIED:**
  - Defined in `src/platform/security/ownership.js:34-45`.
  - Query: Calls `db.projects.findByUser(userId, id)` or `db.projects.findById(id)` checking `record.user_id === userId`.
  - Failure behavior: Throws `AppError("Project not found", 404)` (`src/platform/security/ownership.js:259`). Cross-tenant access strictly returns 404, never 403.

### 7. Project deletion cascades
- **VERIFIED:**
  - Project deletion route: `DELETE /api/projects/:id` (`routes/projects.js:13` -> `controllers/projectsController.js:149-155`) executes `DELETE FROM project WHERE id = id AND user_id = userId`.
  - Cascades in DB: `ON DELETE CASCADE` is configured on:
    - `public.session(project_id)` (`database_schema.sql:98`)
    - `public.workflow(project_id)` (`database_schema.sql:124`)
    - `public.media(project_id)` (`database_schema.sql:171`)
    - `public.media(workflow_id)` (`database_schema.sql:169`)
    - `public.characters(project_id)` (`database_schema.sql:629`)
    - `public.element(workflow_id)` (`migrations/20260720_create_element_table.sql:23`)
  - Consequence for Folders: The new `public.folders` table must have `project_id REFERENCES project(id) ON DELETE CASCADE`. The foreign key from `workflow.folder_id` to `folders(id)` must use `ON DELETE NO ACTION` or `ON DELETE SET NULL` (Decision D-18) so that project cascade deletions are not blocked by folder FK restrictions.

### 8. Existing "same project" validations
- **VERIFIED:**
  - Validated in application layer:
    - `WorkflowServiceBase.moveWorkflow`: checks that target sessions or workflows belong to the same project.
    - `assertOwns`: checks project IDs match user's authorized projects.
    - `imageController.js` and `videoController.js`: verify referenced media/workflows belong to user/project.
  - Database layer: Currently foreign keys only enforce target row existence (e.g., `REFERENCES project(id)`). Composite foreign keys `(project_id, id)` do not exist yet. Phase P3 will introduce composite FK enforcement for `(project_id, parent_id)` on `folders` and `(project_id, folder_id)` on `workflow` (Decision D-25).

---

## 6. Verdict and Conclusion (Step 4)

### Verdict: **Path A applies**

Evidence:
1. `public.workflow` is confirmed as the single logical asset entity representing each user-visible item.
2. `public.media` is confirmed as the asset file/version entity, referencing `workflow_id` with `primary_media_id` tracking the active thumbnail/version.
3. Edits append new `media` rows to the existing `workflow`.
4. Path A directly adds `folder_id` to `public.workflow` without introducing redundant asset tables or altering existing data architecture.

### Implementation Parameters for Phase P3:
- **Table receiving `folder_id`:** `public.workflow`
- **Does `user_id` exist directly on `public.workflow`?** NO. `user_id` is only on `public.project`. Per Decision D-17, Phase P3 will add a nullable `user_id` to `public.workflow` to allow direct indexing and eventual backfill.
- **Is `project_id` nullable on `public.workflow`?** NO (`project_id uuid NOT NULL`).
- **Migration folder and naming scheme:**
  - Folder: `migrations/`
  - Naming scheme: Sequential numbered format `008_<name>.sql` (following `migrations/007_v2_workflow_runs_targets.sql`).
- **Existing conflicting constraints or indexes:** None. `folder_id` does not exist on any table.
- **Naming Map:** Generated and saved as `docs/plan/NAMING_MAP.md` with zero `UNKNOWN` entries on the asset/folder tables.

---

## 7. Risks and Mitigations

1. **Missing `user_id` on `workflow`:**
   - *Risk:* Queries filtering `workflow` by `user_id` currently require joining `project`.
   - *Mitigation:* In P3, maintain scoping via `project_id` and project ownership, while adding `user_id` as a nullable column for future direct scoping (Decision D-17).
2. **PostgreSQL Delete Cascade with `folder_id` FK:**
   - *Risk:* If `workflow.folder_id` has `RESTRICT` or `NO ACTION` without careful ordering during cascade delete of a project, foreign key violations could occur.
   - *Mitigation:* Use `ON DELETE SET NULL` or deferrable constraints (Decision D-18).
3. **Parallel Move Races:**
   - *Risk:* Concurrent moves creating folder cycles.
   - *Mitigation:* Addressed in P3 service-level cycle detection and backlog item for transactional locks (Decision D-19, D-25).

---

## 8. What Could Not Be Verified

- **Live Staging DB schema drift:** Checked exclusively against local schema definitions (`database_schema.sql` and `migrations/*.sql`). Real production/staging Supabase instances could have uncommitted manual patches in the Supabase UI. (Tag: NOT-RUN for live DB inspection; VERIFIED against git repository).
