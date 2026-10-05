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


---

## (g) Request Body Size Limits & Multer Upload Limits (RC1.4-D2)

### Overview
To protect the server from memory exhaustion and denial-of-service, strict request body limits are enforced at the HTTP gateway and upload handlers:
- **Global JSON & URL-encoded limit**: **1MB** for all standard API endpoints.
- **Scoped JSON & URL-encoded limit**: **15MB** exclusively for endpoints that accept Base64 Data URIs or image payload arrays.
- **Multer multipart file uploads**:
  - Image files: maximum **20MB**.
  - Video files: maximum **100MB**.

### Scoped 15MB JSON Routes (Audit Findings)
The following routes accept up to 15MB JSON bodies to accommodate Base64 image payloads:
1. `POST /api/v2/elements`: Element creation (`useNewElement.js:107` via `useElement.js:111`), sends up to 6 Base64 photos in `sourceImages`.
2. `POST /api/characters/create`, `POST /api/characters`, `POST /api/characters/character`: Character creation (`useNewElement.js:107` via `useElement.js:110` or prompt bar), accepts Base64 reference images.
3. `POST /api/characters/:characterId/media`: Attaches detail reference images via `imageUrl` Data URI (`characterService.js:165`).
4. `POST /api/characters/:characterId/sheet-media`: Sets body turnaround sheet media via `imageUrl` Data URI (`characterService.js:143`).
5. `POST /api/assets/upload`: Ingestion endpoint accepting raw JSON with `req.body.base64`.
6. `POST /api/media/ingest`: Canonical ingest endpoint accepting `req.body.base64` or `req.body.source` Data URI.

### Global 1MB Limit
All other routes (including `POST /api/auth/*`, `POST /api/prompt/optimize`, `POST /api/images/generated`, `POST /api/video/generated`, `PATCH /api/projects/*`, etc.) strictly enforce **1MB**. Exceeding requests are rejected immediately with HTTP 413.

### Payments Webhook Invariant
`POST /api/payments/webhook` continues to parse the body as raw bytes (`express.raw({ type: "application/json" })`) before all JSON parsers, preserving raw Buffer integrity for HMAC-SHA256 signature verification.

### Standardized Error Response (HTTP 413)
When any request exceeds the configured body or file limit, the server returns **HTTP 413 Payload Too Large**:
```json
{
  "ok": false,
  "code": "PAYLOAD_TOO_LARGE",
  "message": "Request payload exceeds allowed limit"
}
```
*(For multipart file uploads exceeding 20MB for images or 100MB for videos, message specifies the exact media limit).*

### Required Frontend Actions
1. **Pre-flight file size checks**: In `my-app` file pickers and drag-and-drop zones (`useNewElement.js`, `ImportMediaDialog.jsx`, `mediaApi.js`), validate `file.size` before reading or uploading:
   - If `file.type.startsWith("image/") && file.size > 20 * 1024 * 1024`: Show toast "Image exceeds maximum allowed size of 20MB".
   - If `file.type.startsWith("video/") && file.size > 100 * 1024 * 1024`: Show toast "Video exceeds maximum allowed size of 100MB".
2. **Error handling**: Catch HTTP 413 / `code === "PAYLOAD_TOO_LARGE"` in API client error interceptor and display a user-friendly error rather than generic 500 error messages.
