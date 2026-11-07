# دليل شامل: مسارات الـ API وتعديلات نظام الـ Generation

هذا الملف يوثّق بالتفصيل المعماري الكامل كيفاش يخدم الـ **Generation Pipeline**، شكون الـ **Routers** و الـ **Endpoints**، وشنوة الأكواد اللي تبدلت بالـ Before / After مع تفسير كل سطر.

---

## 1. المعمارية العامة للـ Routing (كيفاش الطلب يمشي)

الـ Request متاع الـ Generation يمشي بالترتيب التالي:

```mermaid
flowchart TD
    A["Frontend (PromptBar / Cinema Studio)"] -->|"POST /images/generated"| B["api.js (Client Axios/Fetch)"]
    B -->|"http://localhost:5000/api/images/generated"| C["Express Root (index.js)"]
    C -->|"/api"| D["API Router (src/api/routes.js)"]
    D -->|"/images" أو "/video"| E["imagesRouter (routes/images.js)"]
    E -->|"/generated"| F["imageController.generateImage"]
    F -->|"prepareAndEnqueue"| G["BullMQ Queue (image-generation-v1)"]
    G -->|"executeImageGeneration"| H["V2 Node (imageGenerationNode.js)"]
    H -->|"models.run(model, canonicalInput)"| I["Models Management System"]
    I -->|"Provider SDK (WaveSpeed / Google / FAL)"| J["External AI Provider API"]
```

---

## 2. تفاصيل الـ Routers والـ Endpoints (المسارات)

### أ. الـ Root Mount في `apiOpenArt/index.js`
```javascript
app.use("/api", apiRouter);
```
كل مسارات الـ Backend تبدأ بـ `/api`.

---

### ب. مسارات الـ API في `apiOpenArt/src/api/routes.js`
هذا هو الـ Router المركزي اللي يوزّع المسارات حسب الـ Module:

| المسار الأساسي (Base Prefix) | الـ Router المسؤول | الغرض |
|---|---|---|
| `/api/images` | `imagesRouter` | المسار الرسمي للـ Generation |
| `/api/video` *(جديد)* | `imagesRouter` | **Alias** لحماية طلبات الفيديو القديمة أو التابعة لأي caller |
| `/api/workflows` | `workflowsRouter` | الـ Queries والـ Mutations متاع المشاريع والجلسات |
| `/api/models` | `modelsRouter` | الـ Catalog متاع الـ Models والـ Parameters |
| `/api/assets` | `assetsRouter` | رفع وتنزيل الملفات والوسائط |
| `/api/v2/workflows` | `v2WorkflowsRouter` | تشغيل ومتابعة الـ Workflows V2 المباشرة |

---

### ج. المسارات الداخلية في `apiOpenArt/routes/images.js`
هذا هو الـ Router اللي يربط الـ HTTP endpoints بالـ Controller:

| HTTP Method | الـ Endpoint الكامل | الـ Controller Handler | الحالة والغرض |
|---|---|---|---|
| `POST` | `/api/images/generated` | `imageController.generateImage` | **المسار الرسمي الموحّد** للصور والفيديو |
| `POST` | `/api/video/generated` | `imageController.generateImage` | **Alias** لحماية الـ Video Models من الـ 404 |
| `POST` | `/api/images/generated/edit/existing` | `imageController.generateImage` | **Alias** لدعم الـ edit على workflow موجود |
| `POST` | `/api/images/generated/edit/new` | `imageController.generateImage` | **Alias** لدعم الـ img2img |
| `POST` | `/api/video/edit` | `imageController.generateImage` | **Alias** لتعديل الفيديو |
| `POST` | `/api/video/motion` | `imageController.generateImage` | **Alias** لطلبات الـ motion |
| `POST` | `/api/video/extend` | `imageController.generateImage` | **Alias** لتمديد الفيديو (`seedance_2_5_extend`) |

---

## 3. الأكواد اللي تبدّلت بالتفصيل (الملف بالملف)

---

### الملف الأول: `my-app/src/features/workflows/api/workflowsApi.js`

#### المشكلة:
كان فمّا شرط قديم يوجّه الـ Video models إلى `/video/generated` ويوجه الـ edit إلى sub-endpoints غير موجودة في الـ backend، فكان يعطي خطأ `404 Route not found`.

#### الكود قبل التعديل (BEFORE):
```javascript
export function useGenerateMutation({ onError } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ payload, isVideo, isCamera, isLighting, isUpscale }) => {
      let endpoint = isVideo ? '/video/generated' : '/images/generated';
      if (isCamera) {
          endpoint = '/camera/change-angles';
          if (isVideo) payload.media_type = "video";
      }
      if (isLighting) endpoint = '/lighting/change-lighting';
      if (isUpscale) endpoint = '/media/upscale';
      
      if (!isVideo && !isCamera && !isLighting && !isUpscale) {
        if (payload.edit_type === 'edit') endpoint = '/images/generated/edit/existing';
        else if (payload.edit_type === 'img2img') endpoint = '/images/generated/edit/new';
      } else if (isVideo && payload.edit_type === 'edit') {
        endpoint = '/video/edit';
      }
      
      if (payload.section === 'motion' || payload.edit_type === 'motion') {
         endpoint = '/video/motion';
      }
      
      const res = await api.post(endpoint, payload);
      if (!res.ok) throw new Error(res.message || 'Workflow execution failed');
      return res;
    },
```

#### الكود بعد التعديل (AFTER):
```javascript
export function useGenerateMutation({ onError } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ payload, isVideo, isCamera, isLighting, isUpscale }) => {
      // Unified backend generation route: /images/generated handles both image and video models
      let endpoint = '/images/generated';
      if (isCamera) {
          endpoint = '/camera/change-angles';
          if (isVideo) payload.media_type = "video";
      }
      if (isLighting) endpoint = '/lighting/change-lighting';
      if (isUpscale) endpoint = '/media/upscale';
      
      const res = await api.post(endpoint, payload);
      if (!res.ok) throw new Error(res.message || 'Workflow execution failed');
      return res;
    },
```

---

### الملف الثاني: `my-app/src/app/cinema-studio/[projectId]/generations/page.js`

#### التعديل:
إضافة حقل `references` داخل كائن الـ `payload` لضمان عدم ضياع أي مراجع صور ممررة من الـ PromptBar.

#### الكود قبل التعديل (BEFORE):
```javascript
const payload = {
    model: request.model,
    prompt: request.prompt,
    project_id: projectId,
    session_id: activeSessionId,
    parameters: request.parameters || {},
    elements: request.elements || [],
    characters: request.characters || [],
};
```

#### الكود بعد التعديل (AFTER):
```javascript
const payload = {
    model: request.model,
    prompt: request.prompt,
    project_id: projectId,
    session_id: activeSessionId,
    parameters: request.parameters || {},
    references: request.references || [], // <-- تمت الإضافة لضمان تمرير الـ references
    elements: request.elements || [],
    characters: request.characters || [],
};
```

---

### الملف الثالث: `apiOpenArt/src/api/routes.js`

#### التعديل:
ربط بادئة المسار `/video` بنفس الـ `imagesRouter` لتوفير حماية كاملة (Route Aliasing) لأي طلب فيديو.

#### الكود قبل التعديل (BEFORE):
```javascript
router.use('/workflows',    workflowsRouter);
router.use('/images',       imagesRouter);
router.use('/characters',   charactersRouter);
```

#### الكود بعد التعديل (AFTER):
```javascript
router.use('/workflows',    workflowsRouter);
router.use('/images',       imagesRouter);
router.use('/video',        imagesRouter); // <-- Alias موجه لنفس الـ Router
router.use('/characters',   charactersRouter);
```

---

### الملف الرابع: `apiOpenArt/routes/images.js`

#### التعديل:
إضافة المسارات الفرعية المشتقة كـ Aliases موجهة لنفس الـ Controller: `imageController.generateImage`.

#### الكود قبل التعديل (BEFORE):
```javascript
import express from "express";
import * as imageController from "../controllers/imageController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/images/generated — image generation via V2 UseCaseRunner */
router.post("/generated", requireAuth, imageController.generateImage);

export default router;
```

#### الكود بعد التعديل (AFTER):
```javascript
import express from "express";
import * as imageController from "../controllers/imageController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/images/generated & /api/video/generated — generation via V2 UseCaseRunner */
router.post("/generated", requireAuth, imageController.generateImage);
router.post("/generated/edit/existing", requireAuth, imageController.generateImage);
router.post("/generated/edit/new", requireAuth, imageController.generateImage);
router.post("/edit", requireAuth, imageController.generateImage);
router.post("/motion", requireAuth, imageController.generateImage);
router.post("/extend", requireAuth, imageController.generateImage);

export default router;
```

---

### الملف الخامس: `apiOpenArt/src/v2/nodes/imageGenerationNode.js`

#### التعديلات:
1. **تحويل الـ Keyframes (معالجة `last_frame` و `input_video`)**:
   - سابقاً: كان الـ Node يحول فقط `input_image` من Workflow ID إلى CDN URL.
   - حالياً: تم دعم تحويل `last_frame` (للـ End Frame في فيديو Wan و Seedance) و `input_video` (لتمديد الفيديو).
2. **استخراج نتيجة الفيديو (Output Normalization)**:
   - سابقاً: كان ينظر فقط إلى `runResult.images?.[0]?.url`. في نماذج الفيديو كانت النتيجة فارغة لأن الـ provider يرجع `videos`!
   - حالياً: تم دعم استخراج `runResult.videos` وحفظ الـ Asset كـ `type: "video"` مع رابط الـ `.mp4` الصحيح.

#### الكود قبل التعديل (BEFORE):
```javascript
  if (
    resolvedParams.input_image &&
    typeof resolvedParams.input_image === "string" &&
    !resolvedParams.input_image.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.input_image);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve input_image "${resolvedParams.input_image}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.input_image = resolvedUrl;
  }

  if (Array.isArray(resolvedParams.images)) {
    resolvedParams.images = await Promise.all(
      resolvedParams.images.map(async (item) => {
        const idOrUrl = typeof item === "string" ? item : (item?.workflow_id || item?.id || item?.url);
        if (typeof idOrUrl === "string" && !idOrUrl.startsWith("http")) {
          const resolved = await resolvePrimaryMediaUrl(idOrUrl);
          return resolved || idOrUrl;
        }
        return idOrUrl;
      })
    );
  }

  // ── 3. Build canonical input: prompt + model params (pass-through) ─────────
  const canonicalInput = { prompt, ...resolvedParams };

  // ── 4. Execute via Models Management System ───────────────────────────────
  const runResult = await run(modelFamily, canonicalInput, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
  });

  // ── 5. Normalize outputs → V2 asset shape ─────────────────────────────────
  const imageUrl = runResult.images?.[0]?.url ?? "";

  const assets = [
    {
      id:       `img-${Date.now()}`,
      type:     "image",
      url:      imageUrl,
      metadata: { model: modelFamily },
    },
  ];
```

#### الكود بعد التعديل (AFTER):
```javascript
  if (
    resolvedParams.input_image &&
    typeof resolvedParams.input_image === "string" &&
    !resolvedParams.input_image.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.input_image);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve input_image "${resolvedParams.input_image}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.input_image = resolvedUrl;
  }

  // ✦ جديد: حل workflow_id الخاص بـ last_frame (End Frame للفيديو)
  if (
    resolvedParams.last_frame &&
    typeof resolvedParams.last_frame === "string" &&
    !resolvedParams.last_frame.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.last_frame);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve last_frame "${resolvedParams.last_frame}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.last_frame = resolvedUrl;
  }

  // ✦ جديد: حل workflow_id الخاص بـ input_video (لتمديد الفيديو)
  if (
    resolvedParams.input_video &&
    typeof resolvedParams.input_video === "string" &&
    !resolvedParams.input_video.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.input_video);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve input_video "${resolvedParams.input_video}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.input_video = resolvedUrl;
  }

  if (Array.isArray(resolvedParams.images)) {
    resolvedParams.images = await Promise.all(
      resolvedParams.images.map(async (item) => {
        const idOrUrl = typeof item === "string" ? item : (item?.workflow_id || item?.id || item?.url);
        if (typeof idOrUrl === "string" && !idOrUrl.startsWith("http")) {
          const resolved = await resolvePrimaryMediaUrl(idOrUrl);
          return resolved || idOrUrl;
        }
        return idOrUrl;
      })
    );
  }

  // ── 3. Build canonical input: prompt + model params (pass-through) ─────────
  const canonicalInput = { prompt, ...resolvedParams };

  // ── 4. Execute via Models Management System ───────────────────────────────
  const runResult = await run(modelFamily, canonicalInput, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
  });

  // ── 5. Normalize outputs → V2 asset shape ─────────────────────────────────
  // ✦ جديد: التحقق الذكي إن كان الناتج فيديو أو صورة
  const isVideo = Boolean(
    (runResult.videos && runResult.videos.length > 0) ||
    (runResult.data?.videos && runResult.data?.videos.length > 0)
  );
  const mediaUrl = isVideo
    ? (runResult.videos?.[0]?.url || (typeof runResult.videos?.[0] === "string" ? runResult.videos[0] : null) || runResult.data?.videos?.[0]?.url || runResult.data?.videos?.[0] || "")
    : (runResult.images?.[0]?.url || (typeof runResult.images?.[0] === "string" ? runResult.images[0] : null) || runResult.data?.images?.[0]?.url || runResult.data?.images?.[0] || "");

  const assets = [
    {
      id:       `${isVideo ? "vid" : "img"}-${Date.now()}`,
      type:     isVideo ? "video" : "image",
      url:      mediaUrl,
      metadata: { model: modelFamily },
    },
  ];
```

---

## 4. نتائج التحقق والاختبارات (Test Suites)

تم تشغيل كل الـ Automated Tests للتحقق من عدم حدوث أي كسر في النظام:

### أ. اختبارات الـ Backend (`apiOpenArt`):
```bash
npm test
# tests 123
# suites 15
# pass 123
# fail 0
```
كل الـ 123 اختباراً مرت بنجاح (بما في ذلك routing النماذج nanobana_2, nanobana_pro, wan_3_0, seedance_2_5, wavespeed_upscale).

### ب. اختبارات الـ Frontend Prompt Bar (`my-app`):
```bash
node --test src/features/prompt-bar/__tests__/*.test.mjs
# tests 40
# suites 0
# pass 40
# fail 0
```
كل الـ 40 اختباراً الخاصة بمنظومة الـ Prompt Bar، الـ Serialization، الـ Mentions، وحساب الكوتا مرت بنجاح تام.
