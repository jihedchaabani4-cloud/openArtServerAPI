# OWN-IMG-1: Verify and Prove Media Parameter String-vs-Array Ownership Bypass
Status: DONE
Commit: 1e09d6f
Self-review score: 98/100 (loops: 1)
Baseline `npm test` before: PASS (698/698 pass across 152 suites hermetically)   After: FAIL on new tests as required by failing-first (12 tests in `referenceAndMediaOwnershipBoundary.test.js`: 7 pass, 5 fail)

## What changed (REUSED / EXTENDED / CREATED)

- CREATED `docs/plan/reports/OWN-IMG-1.md` — full end-to-end execution trace of `parameters.images` and video media parameters, manifest media-parameter ownership matrix, failing-first boundary test evidence (`TESTS 8–12` in `tests/boundary/referenceAndMediaOwnershipBoundary.test.js`), and read-only security assessment of `!imgId.startsWith("http")`.
- EXTENDED `docs/plan/STATE.md` — recorded `OWN-IMG-1`.

---

## 1. Full Execution Trace (`parameters.images` & Video Media Parameters)

- **VERIFIED** (`routes/images.js:9`, `routes/video.js:9`, `src/middleware/auth.js`):
  - `POST /api/images/generated` and `POST /api/video/generated` run `requireAuth` -> `rateLimit(...)` -> `generateImage` / `generateVideo`.
- **VERIFIED** (`controllers/imageController.js:69-94`, `controllers/videoController.js:68-93`):
  - Top-level `references` is sanitized **only** when `if (Array.isArray(references))` (`imageController.js:70`, `videoController.js:69`). When `references` is sent as a plain string `"char-user-A"`, `Array.isArray(references)` is `false` and `sanitizedReferences` becomes `[]`.
  - Direct-URL check on `parameters` (`imageController.js:85-94`, `videoController.js:84-93`) loops `for (const [key, val] of Object.entries(parameters))` and rejects **only** when `typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"))`.
- **VERIFIED** (`controllers/imageController.js:110-123`):
  ```js
  // ── 0c. Enforce Input Media Ownership ────────────────────────────────────
  if (parameters && typeof parameters === "object") {
    if (parameters.input_image && typeof parameters.input_image === "string" && !parameters.input_image.startsWith("http")) {
      await assertOwnsAny(["workflow", "media"], parameters.input_image.trim(), userId);
    }
    if (Array.isArray(parameters.images)) {
      for (const img of parameters.images) {
        const imgId = typeof img === "string" ? img : (img?.workflow_id || img?.id);
        if (typeof imgId === "string" && !imgId.startsWith("http")) {
          await assertOwnsAny(["workflow", "media"], imgId.trim(), userId);
        }
      }
    }
  }
  ```
  - When a client sends `parameters.images = "media-user-A"` (string) or `{ workflow_id: "wf-user-A" }` (single object), `Array.isArray(parameters.images)` at line 115 is **`false`**, so `assertOwnsAny` is **completely bypassed**.
  - When a client sends `parameters.input_image = ["media-user-A"]` (array) or `{ workflow_id: "wf-user-A" }` (object), `typeof parameters.input_image === "string"` at line 112 is **`false`**, bypassing `assertOwnsAny`.
  - `parameters.reference_images`, `parameters.reference_videos`, `parameters.image_url`, `parameters.mask`, `parameters.last_frame`, and `parameters.input_video` are not checked in `imageController.js` at all.
- **VERIFIED** (`controllers/videoController.js:110-125`):
  ```js
  if (parameters && typeof parameters === "object") {
    for (const field of ["input_image", "last_frame", "input_video"]) {
      const val = parameters[field];
      if (typeof val === "string" && val.trim() && !val.trim().startsWith("http")) {
        await assertOwnsAny(["workflow", "media"], val.trim(), userId);
      }
    }
    if (Array.isArray(parameters.images)) {
      for (const img of parameters.images) {
        const imgId = typeof img === "string" ? img : (img?.workflow_id || img?.id);
        if (typeof imgId === "string" && !imgId.trim().startsWith("http")) {
          await assertOwnsAny(["workflow", "media"], imgId.trim(), userId);
        }
      }
    }
  }
  ```
  - Same bypass when `parameters.images` is a string or single object (`Array.isArray` is `false`), when `input_image` / `last_frame` / `input_video` is an array or object (`typeof val === "string"` is `false`), or when `reference_images` / `reference_videos` is sent in any shape.
- **VERIFIED** (`controllers/imageController.js:135-222`, `controllers/videoController.js:137-223`, `src/services/useCaseService.js:70-195`, `src/use-cases/workflowBillingPlan.js:93-147`):
  - Immediately after the skipped ownership check, the controller creates a `workflow` row (`db.workflows.createWorkflow`), creates `media` placeholder row(s) (`db.media.createMedia`), reserves credits (`this.billingRuntime.reserveUseCase`), and enqueues the job (`queue.addUseCaseJob`), returning HTTP `200 OK` (`status: "processing"`).
- **VERIFIED** (`src/models/schema/schemaValidator.js:127-151`):
  ```js
  if (rule.type === "array" && Array.isArray(val)) {
    // ... minItems / maxItems checks only run if Array.isArray(val) is true
  }
  cleanInput[key] = val;
  ```
  - When `rule.type === "array"` and `val` is a plain string `"media-user-A"`, `Array.isArray(val)` is `false`; `validateCanonicalInput` does **not** throw `ValidationError` and passes `"media-user-A"` through in `cleanInput.images`.
- **VERIFIED** (`src/v2/nodes/imageGenerationNode.js:51-77`, `src/v2/nodes/videoGenerationNode.js:52-112`):
  - `imageGenerationNode.js:66` and `videoGenerationNode.js:101` only resolve `resolvedParams.images` via `resolvePrimaryMediaUrl(idOrUrl, userId)` when `if (Array.isArray(resolvedParams.images))`. When `images` is a string, the node skips `resolvePrimaryMediaUrl` and passes the raw string into `models.run(modelFamily, canonicalInput)`.

---

## 2. Media Parameters Across All Model Manifests & Shared Schemas

**VERIFIED** via PowerShell scan of `src/models/manifests/**/model.json` (21 models) and `src/models/shared/{image,video}-parameters.json`:

| Key | Declared Type in Manifests / Shared Schemas | Models / Schemas Declaring Key | Ownership Check Present? | Runs for String? | Runs for Array? | Runs for Single Object `{ workflow_id }`? |
|---|---|---|---|---|---|---|
| `images` | `array` | `gpt_image_2`, `nanobana_2`, `nanobana_pro`, `nanobana_pro_ultra`, `gemini_*` (6 LLM models), `shared/image-parameters.json`, `shared/video-parameters.json` | Yes (`imageController.js:115`, `videoController.js:117`) | **NO (BYPASS -> 200)** | **YES (404)** | **NO (BYPASS -> 200)** |
| `input_image` | `string` | `gpt_image_2`, `nanobana_2`, `nanobana_pro`, `nanobana_pro_ultra`, `ltx_2_3_fast`, `ltx_2_3_pro`, `ltx_2_5_fast`, `ltx_2_5_pro`, `seedance_2_5`, `wan_3_0`, `wavespeed_upscale`, `shared/image-parameters.json`, `shared/video-parameters.json` | Yes (`imageController.js:112`, `videoController.js:111`) | **YES (404)** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `last_frame` | `string` | `ltx_2_3_fast`, `ltx_2_3_pro`, `ltx_2_5_fast`, `ltx_2_5_pro`, `seedance_2_5`, `wan_3_0`, `shared/video-parameters.json` | Yes in `videoController.js:111`; No in `imageController.js` | **YES in video (404)** / **NO in image** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `input_video` | `string` | `ltx_extend`, `ltx_retake`, `seedance_2_5_extend` | Yes in `videoController.js:111`; No in `imageController.js` | **YES in video (404)** / **NO in image** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `reference_images` | `array` | `shared/image-parameters.json:50`, `shared/video-parameters.json:24` | **NO** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `reference_videos` | `array` | `shared/video-parameters.json:34` | **NO** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `image_url` | `string` | `shared/image-parameters.json:45`, `shared/video-parameters.json:14` (rejected at root `req.body.image_url` with `400`, unchecked inside `parameters.image_url`) | **NO** (inside `parameters`) | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `mask` | `string` | `shared/image-parameters.json:60` | **NO** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** | **NO (BYPASS -> 200)** |
| `references` (top-level `req.body.references`) | `array` (controller contract) | `imageController.js:69-82,106-108`, `videoController.js:68-81,105-107` | Yes (`assertOwnsAny`) | **NO** (`sanitizedReferences` becomes `[]`, silently dropped; returns `200` instead of `404`) | **YES (404)** | **NO** (`sanitizedReferences` becomes `[]`, returns `200` instead of `404`) |

---

## 3. Failing-First Boundary Test Evidence

- **VERIFIED**: Added `TESTS 8–12` to `tests/boundary/referenceAndMediaOwnershipBoundary.test.js` and ran `node --test tests/boundary/referenceAndMediaOwnershipBoundary.test.js`:
  ```text
  ℹ tests 12
  ℹ suites 1
  ℹ pass 7
  ℹ fail 5
  ✖ TEST 8 (OWN-IMG-1): Image Gen: parameters.images as a STRING with User A's ID returns 404 and creates no records/holds
    AssertionError [ERR_ASSERTION]: Expected 404, got 200
  ✖ TEST 9 (OWN-IMG-1): Image Gen: parameters.images as ARRAY, [{ workflow_id }], and { workflow_id } with User A's ID returns 404
    AssertionError [ERR_ASSERTION]: Shape {"workflow_id":"wf-user-A"} expected 404, got 200
  ✖ TEST 10 (OWN-IMG-1): Image Gen: reference_images (string/array), input_image (array/object), and top-level references (string) with User A's ID return 404
    AssertionError [ERR_ASSERTION]: Payload {"parameters":{"reference_images":"wf-user-A"}} expected 404, got 200
  ✖ TEST 11 (OWN-IMG-1): Video Gen: images, reference_images, reference_videos, input_image, last_frame, input_video (string/array/object) with User A's ID return 404
    AssertionError [ERR_ASSERTION]: Video payload {"parameters":{"images":"wf-user-A"}} expected 404, got 200
  ✖ TEST 12 (OWN-IMG-1): Legitimate Owner: User A with parameters.images as a STRING and as an ARRAY both return 200
    AssertionError [ERR_ASSERTION]: String parameters.images must be normalized to array ['media-user-A'] at boundary (actual: 'media-user-A')
  ```
- **Verdict on Suspicion**: **CONFIRMED (`VERIFIED`)**. Sending `parameters.images` as a string (or single object `{ workflow_id }`), sending `reference_images` / `reference_videos`, or sending `input_image` / `last_frame` / `input_video` as an array/object bypasses the controller ownership check and creates a workflow row, media placeholder row, credit reservation hold, and queued job (`HTTP 200`).

---

## 4. Read-Only Assessment: Values Starting with `http` (`!imgId.startsWith("http")`)

- **Why `!val.startsWith("http")` exists and how `http(s)://` values behave (`VERIFIED`)**:
  1. **Top-level string parameters (`parameters.input_image = "https://..."`)**: Rejected earlier with `400 Bad Request` by `imageController.js:85-94` and `videoController.js:84-93` (`if (typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://")))`). For top-level strings, `!val.startsWith("http")` at `imageController.js:112` and `videoController.js:113` is unreachable.
  2. **Array / object parameters (`parameters.images = ["https://..."]` or `[{ url: "https://..." }]`)**:
     - Bypass `imageController.js:85-94` and `videoController.js:84-93` because `typeof parameters.images` is `"object"` (not `"string"`).
     - Bypass the ownership check at `imageController.js:118` and `videoController.js:120` because `!imgId.startsWith("http")` is `false` (and for `{ url: "https://..." }`, `img?.workflow_id || img?.id` evaluates to `undefined`).
  3. **What happens afterwards (`VERIFIED`)**:
     - In `src/v2/nodes/imageGenerationNode.js:68-75` and `src/v2/nodes/videoGenerationNode.js:103-110`, `item?.workflow_id || item?.id || item?.url` extracts the `http(s)://` URL, skips `resolvePrimaryMediaUrl` because `!idOrUrl.startsWith("http")` is `false`, and leaves the raw URL in `resolvedParams.images`.
     - `models.run()` maps `resolvedParams.images` via `src/models/mapping/parameterMapper.js:71-105` into the provider payload and sends it in the JSON body to the external provider (`src/models/runtime/wavespeed/runner.js:38`, `src/models/runtime/generic/restRunner.js:53`).
     - The OpenArt backend server itself does **not** `fetch()` URLs from `parameters.images` during generation; the external provider fetches them.
  4. **Host allow-list (`VERIFIED`)**: **None**. There is no hostname or domain allow-list in `imageController.js`, `videoController.js`, `schemaValidator.js`, `imageGenerationNode.js`, or `videoGenerationNode.js`.
  5. **Severity**: **High** — allows a client to bypass the "workflow IDs only" rule (`400`) and ownership check (`404`) by wrapping any `http(s)://` URL inside `parameters.images` (`["https://..."]` or `[{ url: "https://..." }]`), enabling cross-tenant asset URL reuse if a CDN URL is known and blind third-party SSRF/URL fetching through the upstream AI provider. (Per prompt instructions: reported read-only; not modified in `OWN-IMG-2`).

## Self-review findings

- PASS — Security: traced every media parameter and verified cross-tenant 404 requirements
- PASS — Correctness: every claim cites exact `file:line` and is tagged `VERIFIED`
- PASS — Operability: no `console.*` added
- PASS — Tests: hermetic boundary tests reproduce the exact vulnerability before any fix
