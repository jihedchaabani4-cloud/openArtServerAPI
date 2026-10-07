# Frontend Contract Changes Needed (Post-Phase 0 Hardening)

This document details the exact changes needed in the frontend (`my-app/`) to align with the Phase 0 server contract hardening. No frontend code has been edited.

---

## (a) Reference Images: Eliminating Raw URLs (`referenceUtils.js:131`)

### Current State
In [my-app/src/features/workflows/utils/referenceUtils.js:131](file:///c:/Users/jihad/Desktop/open%20art/my-app/src/features/workflows/utils/referenceUtils.js#L131):
```javascript
// Current frontend fallback
return {
    workflow_id: r.id || r.workflow_id || r.url,
    position: index,
    input_type: r.type || "character",
};
```
When a reference image has not yet been persisted to the server with a UUID `id` or `workflow_id`, the frontend currently passes `r.url` as `workflow_id`.
Under Phase 0 security hardening, foreign media and arbitrary strings passed to `verifyMediaOwnership` or UUID lookup will either fail validation or result in a `404 Not Found`. Passing raw URLs as UUIDs violates the schema.

### Minimal Frontend Fix
The frontend must adopt an **ingest-first pattern** prior to submitting generation requests:
1. When a user uploads or selects an external image reference, immediately invoke the canonical ingest endpoint:
   ```javascript
   // POST /api/media/ingest
   const formData = new FormData();
   formData.append("file", fileBlob);
   // OR send JSON payload with source URL:
   // { "source": externalUrl, "purpose": "character_reference" }
   const res = await api.post("/api/media/ingest", payload);
   const { media_id, workflow_id } = res.data;
   ```
2. Store the returned `workflow_id` or `media_id` on the reference state object.
3. In `referenceUtils.js:131`, eliminate the fallback to `r.url`:
   ```javascript
   // Minimal fix: require resolved entity ID
   if (!r.id && !r.workflow_id) {
       throw new Error(`Reference image at index ${index} must be ingested before running generation.`);
   }
   return {
       workflow_id: r.workflow_id || r.id,
       position: index,
       input_type: r.type || "character",
   };
   ```

---

## (b) Generation Count Behavior

### Current Server Behavior (Verified via `tests/boundary/countBehaviorBoundary.test.js`)
We verified against the live controller pipeline with `nanobana_2` and all UI models:
1. **Top-level `count: 4` (`req.body.count = 4`)**:
   - The use-case orchestrator reads `req.body.count`. However, because `nanobana_2` manifest has `output_cardinality: "single"` and the workflow YAML specifies a single placeholder, the server creates **1 placeholder**.
   - Result: Returns **HTTP 200 OK** with `{ placeholders: [ { id: "..." } ] }` (length 1). The surplus count is silently clamped.
2. **Nested `parameters.count: 4` (`req.body.parameters.count = 4`)**:
   - The parameter validator (`src/models/schema/schemaValidator.js`) strips or ignores `count` if it is not declared in the model manifest schema.
   - Result: Returns **HTTP 200 OK** with 1 placeholder.
3. **UI Offered Models**:
   - None of the models currently available in the UI catalog declare multi-output capability or `count` in their parameter schemas. All models silently clamp to 1 placeholder today.

### Proposed Consistent Behavior (Awaiting User Decision)
- **Recommendation**: Instead of silently clamping and charging/generating 1 item when the user asked for 4, return an explicit HTTP 400 error:
  ```json
  {
    "ok": false,
    "errorCode": "INVALID_INPUT",
    "message": "Model 'nanobana_2' does not support generating multiple outputs (count: 4 requested, max supported: 1)."
  }
  ```
- **Rationale**: Prevents unexpected billing and user confusion where the UI asked for 4 images, paid for 1, and only received 1.

---

## (c) Catalog Parameter Exposure for Count

### Catalog Audit
Auditing `GET /api/models` manifests for all registered models:
- **`nanobana_2`**: No `count` parameter in schema.
- **`nanobana_pro`**: No `count` parameter in schema.
- **`nanobana_pro_ultra`**: No `count` parameter in schema.
- **`gpt_image_2`**: No `count` parameter in schema.
- **`seedance_2_5`**: Video model (single output only).
- **`wan_3_0`**: Video model (single output only).
- **`ltx_*`**: Video models (single output only).

### Frontend Catalog Recommendation
In [my-app/src/features/workflows/components/flow-prompt-box/FlowPromptBoxSettings.jsx](file:///c:/Users/jihad/Desktop/open%20art/my-app/src/features/workflows/components/flow-prompt-box/FlowPromptBoxSettings.jsx), the `x1`, `x2`, `x3`, `x4` count selector buttons should be conditionally hidden unless:
```javascript
Boolean(selectedModel?.parameters?.count || selectedModel?.capabilities?.multi_output)
```
Currently, since no backend manifest declares this capability, hiding or locking the count selector to `1` prevents user frustration.

---

## (d) Prompt Optimizer Import Fix

### Current State
In [my-app/src/features/workflows/hooks/usePromptOptimizer.js:4](file:///c:/Users/jihad/Desktop/open%20art/my-app/src/features/workflows/hooks/usePromptOptimizer.js#L4):
```javascript
import { apiClient } from "@/shared/api/apiClient"; // ❌ Module not found! File does not exist
```

### Confirmation & Minimal Fix
- File `my-app/src/shared/api/apiClient.js` **does not exist**.
- The canonical API client instance in `my-app/` is exported from `src/shared/api/client.ts` (or `client.js`):
  ```typescript
  export const api = ...;
  export default api;
  ```
- Minimal fix in `my-app/src/features/workflows/hooks/usePromptOptimizer.js:4`:
  ```javascript
  // Correct import
  import { api } from "@/shared/api/client";
  ```
  And replace `apiClient.post(...)` with `api.post(...)`.

---

## (e) Prompt Optimize Rate Limit Discrepancy

### Ground Truth
- The authoritative rate limit configuration is in [src/config/rateLimitPolicies.js:43-47](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/config/rateLimitPolicies.js#L43-L47):
  ```javascript
  promptOptimization: {
      points: 30,         // 30 requests
      duration: 60,       // per 60 seconds (1 minute)
      keyBy: "user",      // Keyed by authenticated user ID
  }
  ```
- This policy is applied directly in [routes/prompt.js:16](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/routes/prompt.js#L16):
  ```javascript
  router.post("/optimize", requireAuth, rateLimit("promptOptimization"), ...);
  ```
- **Conclusion**:
  - The actual rate limit is **30 requests per 60 seconds** (not 20/min).
  - Any mention of 20/min in previous documentation was an errant draft note; the code enforces `points: 30, duration: 60`.

---

## (f) Frontend Hardcoded Secret Elimination (`ElementVisionService.js`)

### Current State
In `my-app/src/features/workflows/services/ElementVisionService.js` (lines 103, 107, 377, 394):
```javascript
const internalSecret = process.env.INTERNAL_SECRET || "openart_internal_s2s_secret_2026";
// Sent in fetch headers:
headers: {
    "Content-Type": "application/json",
    "x-internal-secret": internalSecret,
    ...
}
```

### Detailed Impact & Vulnerability
1. **Header Sent**: `x-internal-secret: "openart_internal_s2s_secret_2026"`.
2. **Backend Routes Consuming It**:
   - `src/middleware/auth.js:14` (internal secret authentication bypass)
   - `src/domain/project/ProjectReadService.js:374` (`_verifyMediaOwnership` bypass for `GET /api/workflows/project-data/:projectId` and `getWorkflowByMedia`)
   - `src/platform/workflow/WorkflowAuthorizationService.js:18` (`verifyWorkflowOwnership` bypass for `PATCH /api/workflows/workflows/:id`)
3. **What the Frontend Uses It For**:
   - `fetchWorkflowContext`: Calls `GET /api/workflows/project-data/${projectId}` to fetch image URLs and element type.
   - `persistElementMetadata`: Calls `PATCH /api/workflows/workflows/${workflowId}` to save AI-generated `description` and `keywords`.
4. **What Breaks Now**:
   - The backend removed `"openart_internal_s2s_secret_2026"` in Phase 0 Task R1 (`e76305d`).
   - The server constant-time comparison rejects `"openart_internal_s2s_secret_2026"`.
   - Without an authorized user JWT in `headers.authorization`, these requests will be rejected with **HTTP 401 / 403 / 404**.
5. **Minimal Fix Required in `ElementVisionService.js`**:
   - Delete lines 103, 107, 377, 394 (`internalSecret` variable and `x-internal-secret` header).
   - Use the standard authenticated API client or forward the active user's Supabase JWT:
     ```javascript
     headers: {
         "Content-Type": "application/json",
         "Authorization": `Bearer ${userSessionToken}`,
     }
     ```
   - The backend already enforces tenant ownership cleanly via `req.user.id` on both `GET /api/workflows/project-data/:projectId` and `PATCH /api/workflows/workflows/:id`. When the user is authenticated and owns the workflow, normal JWT authorization succeeds without any internal secret.

6. **RC1.4-D2.5 & D2.6 Security Hardening Finding**:
   - The backend `src/middleware/auth.js` now strictly restricts `x-internal-secret` to an explicit server-to-server route allow-list (`INTERNAL_SECRET_ALLOWED_METHOD_PATH_PAIRS`) and requires `INTERNAL_AUTH_ENABLED === "true"`.
   - Sending `x-internal-secret` on non-allowlisted endpoints (e.g. `/api/wallet/*`, `/api/payments/*`) is strictly ignored and rejected without a valid Supabase JWT.
   - The frontend (`my-app`) must never bundle or transmit `x-internal-secret` under any circumstance. All browser requests must authenticate strictly via standard user session JWTs.

### ElementVisionService: stop using the internal secret
- **Current behavior**: Sends `x-internal-secret` and `x-user-id`.
- **Required change**: Use the logged-in user's JWT (`Authorization: Bearer <access token>`, same way the other frontend services do) on exactly these two calls:
  - `GET /api/workflows/project-data/:projectId`
  - `PATCH /api/workflows/workflows/:id`
  Remove both internal headers (`x-internal-secret` and `x-user-id`). Remove `INTERNAL_SECRET` from every frontend env file and build config.
- **Deploy order**: Ship the frontend change BEFORE (or together with) the backend release that turns the internal path off, otherwise element vision breaks.
- **Check after deploy**: Element vision works for a normal logged-in user; the network tab shows no `x-internal-secret`.




---

## (g) Request Body Size Limits & Multer Upload Limits (RC1.4-D2 & D2.1)

### Overview
To protect the server from memory exhaustion and denial-of-service, strict request body limits are enforced at the HTTP gateway and upload handlers:
- **Global JSON & URL-encoded limit**: **1MB** for all standard API endpoints.
- **Scoped JSON & URL-encoded limit**: **30MB** (capped at 30MB) exclusively for endpoints that accept Base64 Data URIs or image payload arrays.
- **Multer multipart file uploads**:
  - Image-only routes (`/api/characters/*`, `/api/v2/elements/:id/images`): strictly **20MB** directly via multer `limits.fileSize`, with `fileFilter` rejecting non-image MIME types (HTTP 415) before buffering into memory.
  - Media routes with video support (`/api/assets/upload`, `/api/media/ingest`): **100MB** for video, validated to **20MB** for images.

### Real-World Audit: Element Multi-Photo Payloads & Compression Requirement
- **Maximum Photos**: `my-app` allows up to **6 photos** to be attached to an element (`useNewElement.js:260`, `ElementDetailsGallery.jsx:22`).
- **Client-Side Compression**: Currently, `elementService.js:75` (`readFileAsDataUrl`) reads the raw `File` directly into Base64 using `FileReader.readAsDataURL` with **no client-side resizing or compression**.
- **Payload Analysis**:
  - **Camera Originals (Worst Case)**: 6 photos from an iPhone/modern smartphone (5-10MB each) = 30-60MB binary => **41MB - 82MB Base64 payload**. This will exceed the server's hard 30MB cap!
  - **Realistic Phone Photos**: 5 photos @ 3-4MB each = 15-20MB binary => **20.5MB - 27.4MB Base64 payload**, which fits under the updated **30MB** scoped limit.
- **Critical Frontend Requirement**: The frontend MUST implement client-side canvas downscaling/compression in `elementService.readFileAsDataUrl` (e.g. max 2048px dimension, 0.85 JPEG quality, ~1MB per photo) before converting to Base64 so that users uploading 6 uncompressed phone photos never trigger HTTP 413.

### Final Route-to-Limit Reference Table
| Route | Method | Parser | Limit | Media Types Accepted | Error Code on Exceed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/payments/webhook` | POST | `express.raw` | Raw buffer | `application/json` | N/A (Signature verified) |
| `/api/v2/elements` | POST | `express.json` (scoped) | **30MB** | `application/json` (Base64 `sourceImages`) | 413 `PAYLOAD_TOO_LARGE` |
| `/api/v2/elements/*` | POST / PATCH | `express.json` (scoped) | **30MB** | `application/json` | 413 `PAYLOAD_TOO_LARGE` |
| `/api/characters/create`, `/api/characters`, `/api/characters/character` | POST | `express.json` (scoped) | **30MB** | `application/json` (Base64 reference images) | 413 `PAYLOAD_TOO_LARGE` |
| `/api/characters/:characterId/media` | POST | `express.json` (scoped) | **30MB** | `application/json` (Base64 `imageUrl`) | 413 `PAYLOAD_TOO_LARGE` |
| `/api/characters/:characterId/sheet-media` | POST | `express.json` (scoped) | **30MB** | `application/json` (Base64 `imageUrl`) | 413 `PAYLOAD_TOO_LARGE` |
| `/api/characters/create`, `/api/characters`, `/api/characters/character` | POST | `multer` (`file`) | **20MB** | `image/*` only | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| `/api/characters/:characterId/media` | POST | `multer` (`file`) | **20MB** | `image/*` only | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| `/api/characters/:characterId/sheet-media` | POST | `multer` (`file`) | **20MB** | `image/*` only | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| `/api/characters/:characterId/upload` | POST | `multer` (`file`) | **20MB** | `image/*` only | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| `/api/v2/elements/:id/images` | POST | `multer` (`file`) | **20MB** | `image/*` only | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| `/api/assets/upload` | POST | `express.json` (scoped) | **30MB** | `application/json` (`body.base64`) | 413 `PAYLOAD_TOO_LARGE` |
| `/api/assets/upload` | POST | `multer` (`file`) | **100MB** (video) / **20MB** (image) | `image/jpeg,png,webp,gif,avif`, `video/mp4,webm,quicktime` | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| `/api/media/ingest` | POST | `express.json` (scoped) | **30MB** | `application/json` (`body.base64`, `body.source`) | 413 `PAYLOAD_TOO_LARGE` |
| `/api/media/ingest` | POST | `multer` (`file`) | **100MB** (video) / **20MB** (image) | `image/*`, `video/*` | 413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_MEDIA_TYPE` |
| **All other routes** (`/api/auth/*`, `/api/prompt/optimize`, `/api/images/*`, `/api/video/*`, etc.) | ALL | `express.json` (global) | **1MB** | `application/json` | 413 `PAYLOAD_TOO_LARGE` |

### Required Frontend Actions
1. **Pre-flight file size checks**: In `my-app` file pickers and drag-and-drop zones (`useNewElement.js`, `ImportMediaDialog.jsx`, `mediaApi.js`), validate `file.size` before reading or uploading:
   - If `file.type.startsWith("image/") && file.size > 20 * 1024 * 1024`: Show toast "Image exceeds maximum allowed size of 20MB".
   - If `file.type.startsWith("video/") && file.size > 100 * 1024 * 1024`: Show toast "Video exceeds maximum allowed size of 100MB".
2. **Client-side image compression**: Implement automatic downscaling (canvas/webp/jpeg at 0.85) in `elementService.readFileAsDataUrl` so multiple phone photos stay well below 30MB.
3. **Error handling**: Catch HTTP 413 / `code === "PAYLOAD_TOO_LARGE"` in API client error interceptor and display a user-friendly error rather than generic 500 error messages.

---

## (h) Error Payload Handling in `LoginPage.jsx` & API Client (RC1.4-D1.2)

### Current State in `my-app/src/app/login/page.jsx:38`
```javascript
const data = await res.json();
if (!res.ok) {
  setError(data.error || "Login failed. Please try again.");
  setIsLoading(false);
  return;
}
```

### Problem
When rate-limited (HTTP 429), the server returns `{ ok: false, code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later." }` alongside a `Retry-After: <seconds>` HTTP header.
Because `data.error` is undefined on standardized 429, 503, and 413 error responses (which use `{ code, message }`), the frontend falls back to `"Login failed. Please try again."`, obscuring the rate-limit status and retry duration from the user.

### Required Frontend Change
Update `LoginPage.jsx:38` to read `data.message || data.error`:
```diff
--- a/src/app/login/page.jsx
+++ b/src/app/login/page.jsx
@@ -35,7 +35,7 @@ export default function LoginPage() {
       const data = await res.json();
 
       if (!res.ok) {
-        setError(data.error || "Login failed. Please try again.");
+        const retryAfter = res.headers.get("Retry-After");
+        const retryText = retryAfter ? ` (retry in ${retryAfter}s)` : "";
+        setError((data.message || data.error || "Login failed. Please try again.") + retryText);
         setIsLoading(false);
         return;
       }
```
Similarly, any global API error handlers should read `data.message` for HTTP 503 (`SERVICE_UNAVAILABLE`) and HTTP 413 (`PAYLOAD_TOO_LARGE`).

---

## (i) Folders (Phase 3)

### 1. Project Sidebar Hierarchy
The project sidebar hierarchy should be organized into:
- Project brief
- Settings
- Elements
- Tools
- Folders
  - **All assets**: A fixed, top-level item that queries all assets in the project (`GET /api/projects/:projectId/assets` without `folderId`).
  - **User Folders Tree**: Rendered hierarchically under "Folders", displaying the folder name and direct `assetCount` badge next to each folder.

### 2. Building the Client-side Folder Tree
1. Invoke `GET /api/projects/:projectId/folders` once on project load.
2. The response is a flat array of folder objects:
   ```json
   {
     "items": [
       {
         "id": "6f1c7d2e-0000-0000-0000-000000000001",
         "projectId": "a2b3c4d5-0000-0000-0000-000000000001",
         "parentId": null,
         "name": "Scene 1",
         "position": 0,
         "assetCount": 12,
         "createdAt": "2026-10-07T10:00:00.000Z",
         "updatedAt": "2026-10-07T10:00:00.000Z"
       }
     ]
   }
   ```
3. Group the flat array by `parentId` (`null` for root folders) to build the hierarchical tree in client memory. No recursive SQL or multi-request queries are needed.
4. `assetCount` indicates only direct child assets in that specific folder (excluding descendants).

### 3. Breadcrumb Construction
Build breadcrumbs dynamically from the in-memory flat folder list:
- Root level: `All` (or `Project Name`)
- Folder level: `All / Scene 1 / Shots` by walking `parentId` up to `null`.

### 4. API Contract Endpoints
- `GET /api/projects/:projectId/folders`
  - Returns `{ items: [Folder, ...] }` sorted by `position`, then `name`.
- `POST /api/projects/:projectId/folders`
  - Body: `{ "name": "Scene 1", "parentId": null }` (`parentId` optional).
  - Returns 201 with created Folder object.
- `PATCH /api/folders/:folderId`
  - Body: Any of `{ "name", "parentId", "position" }`.
  - Returns 200 with updated Folder object. `projectId` is immutable.
- `DELETE /api/folders/:folderId`
  - Returns 204 No Content. Returns 409 `FOLDER_NOT_EMPTY` if it contains assets or sub-folders.
- `GET /api/projects/:projectId/assets?folderId=<id>&includeDescendants=true&limit=50&cursor=<token>`
  - Returns `{ items: [...], nextCursor: "..." | null }`.
- `PATCH /api/assets/:assetId/folder`
  - Dedicated route for moving assets. Body: `{ "folderId": "<uuid>" | null }`.
  - Passing `folderId: null` moves the asset back to project root.

### 5. Error Codes & UI Toast / Modal Handling
- `FOLDER_NOT_EMPTY`: Display "Move or delete the content first". Folder cannot be deleted while containing assets or child folders.
- `FOLDER_NAME_TAKEN`: Display "A folder with this name already exists at this level".
- `FOLDER_CYCLE`: Display "Cannot move a folder into itself or one of its sub-folders".
- `FOLDER_DEPTH_EXCEEDED`: Display "Maximum folder nesting depth (3 levels) reached".
- `FOLDER_LIMIT_REACHED`: Display "Maximum folder limit (100 folders) reached for this project".

### 6. Generation & Upload Context
- When generating images (`POST /api/images/generate`), video (`POST /api/video/generate`), or uploading media (`POST /api/assets/upload`), include `folderId` if the user is currently inside a folder view.
- Omit `folderId` (or pass `null`) when the user is viewing "All assets" or root.

### 7. Asset Moves
- Moving an asset must use the dedicated endpoint `PATCH /api/assets/:assetId/folder`.
- Setting `{ "folderId": null }` moves the asset back to the project root.
- The generic update route `PATCH /api/workflows/workflows/:id` rejects `folderId`, `projectId`, and `userId` to protect against mass-assignment.

### 8. View Toggle: Direct Assets vs. Sub-folder Assets
- By default, opening a folder queries direct child assets only (`GET /api/projects/:projectId/assets?folderId=<id>`).
- Provide an "Include sub-folders" toggle in the asset gallery toolbar that sets `includeDescendants=true` to view all assets within the entire subtree.

