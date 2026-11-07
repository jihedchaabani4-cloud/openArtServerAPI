# Generation API Foundation Architecture

## 1. Before: Old Mixed Architecture

Previously, generation routing had become blurred between Image and Video domains:

```text
[Frontend useGenerateMutation]
        │
        ├── (isVideo === true)  ──► POST /api/video/generated (Returned 404!)
        ├── (edit_type === 'edit') ──► POST /api/images/generated/edit/existing (404!)
        ├── (isCamera) ──► POST /camera/change-angles (404!)
        └── (default)  ──► POST /api/images/generated
                                    │
                                    ▼
                          [Express: index.js]
                                    │
                         router.use('/images', imagesRouter)
                         router.use('/video',  imagesRouter)  <-- Route Alias Hack!
                                    │
                                    ▼
                         [imagesRouter]
                         POST /generated ──► imageController.generateImage
                         POST /edit ────────► imageController.generateImage (Alias)
                         POST /motion ──────► imageController.generateImage (Alias)
                         POST /extend ──────► imageController.generateImage (Alias)
```

### Flaws of Old Architecture:
1. **Conflated Responsibilities**: Video was routed through the Image router via `router.use('/video', imagesRouter)`.
2. **Controller Overload**: `imageController` handled video placeholders and enqueued `image-generation-v1` for both media types.
3. **Unregistered Aliases**: Phantom endpoints (`/video/edit`, `/video/motion`, `/camera/change-angles`) created confusion and false safety nets.

---

## 2. After: Clean Decoupled Foundation

```text
                           MY APP (Frontend)
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
           Generated Image                 Generated Video
                  │                               │
                  ▼                               ▼
       POST /api/images/generated      POST /api/video/generated
                  │                               │
══════════════════╪═══════════════════════════════╪══════════════════════════
                  │     apiOpenArt (Backend)      │
                  ▼                               ▼
       [imagesRouter (routes/images.js)] [videoRouter (routes/video.js)]
                  │                               │
                  ▼                               ▼
          imageController                  videoController
                  │                               │
                  ▼                               ▼
       image-generation-v1 flow        video-generation-v1 flow
       (imageGenerationNode)           (videoGenerationNode)
                  │                               │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                      MODELS MANAGEMENT SUBSYSTEM
                                  │
                      models.run(model, canonicalInput)
                                  │
                                  ▼
                         Provider Bindings
                                  │
                                  ▼
                    WaveSpeed / Google / FAL SDK
```

### Key Architectural Boundaries:
1. **Independent HTTP Entry Points**:
   - `POST /api/images/generated` is exclusively handled by `imagesRouter` and `imageController`.
   - `POST /api/video/generated` is exclusively handled by `videoRouter` and `videoController`.
2. **Independent Use Case & Node Execution**:
   - Image pipeline runs `useCaseId: "image-generation-v1"` $\to$ `imageGenerationNode.js`.
   - Video pipeline runs `useCaseId: "video-generation-v1"` $\to$ `videoGenerationNode.js`.
3. **Models Management is an Independent Subsystem**:
   - Models Management is NOT an API layer or shared HTTP router.
   - It is a standalone system responsible for model catalog, canonical input validation, provider bindings, and runtime execution via `models.run()`.
   - Both Image and Video execution flows call `models.run(model, canonicalInput)` when they need to run a model.

---

## 3. Active Generation Surface

The current foundation strictly supports only two operations:

| Operation | HTTP Method | Endpoint | Router | Controller | Use Case |
|---|---|---|---|---|---|
| **Generated Image** | `POST` | `/api/images/generated` | `routes/images.js` | `imageController.generateImage` | `image-generation-v1` |
| **Generated Video** | `POST` | `/api/video/generated` | `routes/video.js` | `videoController.generateVideo` | `video-generation-v1` |

---

## 4. Removed Routes & Aliases

The following experimental and out-of-scope aliases were removed from the active generation routing surface:

| Removed Route | Former Target | Rationale for Removal |
|---|---|---|
| `router.use('/video', imagesRouter)` | `imagesRouter` | Removed. Conflated Video API with Image Router. Replaced by dedicated `videoRouter`. |
| `POST /images/generated/edit/existing` | `imageController.generateImage` | Removed alias. Out-of-scope edit operation. |
| `POST /images/generated/edit/new` | `imageController.generateImage` | Removed alias. Out-of-scope img2img operation. |
| `POST /video/edit` | `imageController.generateImage` | Removed alias. Out-of-scope video editing operation. |
| `POST /video/motion` | `imageController.generateImage` | Removed alias. Out-of-scope motion operation. |
| `POST /video/extend` | `imageController.generateImage` | Removed alias. Out-of-scope video extension operation. |

*Note: None of these features are built via fake aliases. Each will be introduced as an intentional, dedicated feature and route in future milestones.*

---

## 5. Preserved Models Management & Canonical Parameters

The Models Management subsystem remains completely intact and untouched by the API routing cleanup:

1. **Strict Canonical Parameter Invariant**:
   - `images` (array of reference image IDs) $\neq$ `input_image` (single primary/start frame image ID).
   - No implicit conversions (`images[0] -> input_image` or `input_image -> images`).
2. **Canonical Vocabulary**:
   - `images`: Multi-reference images.
   - `input_image`: Start frame / primary single image.
   - `last_frame`: End frame for video models (`wan_3_0`, `seedance_2_5`).
   - `input_video`: Source video continuation for extend models (`seedance_2_5_extend`).
   - `generate_audio`: Audio generation toggle.
3. **Provider Bindings & Runtime**:
   - Declarative parameter mappings (`parameterMap`), value mappings (`valueMap`), and custom adapters remain in `src/models/`.
   - Neither the Image API nor the Video API contains provider-specific logic.

---

## 6. Exact Files Changed

### Backend (`apiOpenArt`):
1. [`src/api/routes.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/api/routes.js) — Mounted dedicated `videoRouter` at `/video` (removed `imagesRouter` alias).
2. [`routes/images.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/routes/images.js) — Cleaned to strictly export `POST /generated` -> `imageController.generateImage`.
3. [`routes/video.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/routes/video.js) **[NEW]** — Dedicated Video router exporting `POST /generated` -> `videoController.generateVideo`.
4. [`controllers/imageController.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/imageController.js) — Domain-aligned Image generation controller (`step_id: "image_generation"`, `useCaseId: "image-generation-v1"`).
5. [`controllers/videoController.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/videoController.js) **[NEW]** — Dedicated Video generation controller (`step_id: "video_generation"`, `useCaseId: "video-generation-v1"`).
6. [`src/v2/nodes/imageGenerationNode.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/nodes/imageGenerationNode.js) — Pure image execution node outputting `type: "image"`.
7. [`src/v2/nodes/videoGenerationNode.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/nodes/videoGenerationNode.js) **[NEW]** — Pure video execution node outputting `type: "video"`.
8. [`src/v2/nodes/index.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/nodes/index.js) — Registered `"video-generation"` node.
9. [`src/v2/nodes/safety/NodeSafetyService.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/nodes/safety/NodeSafetyService.js) — Added `assertVideoInputs`.
10. [`src/v2/registry/workflows/video-generation-v1.yaml`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/registry/workflows/video-generation-v1.yaml) **[NEW]** — Video generation workflow definition.
11. [`src/use-cases/definitions/videoGeneration.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/use-cases/definitions/videoGeneration.js) **[NEW]** — Video generation use case definition.
12. [`src/use-cases/registerUseCases.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/use-cases/registerUseCases.js) — Registered `videoGenerationUseCase`.
13. [`src/use-cases/workflowBillingPlan.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/use-cases/workflowBillingPlan.js) — Added `"video-generation"` to `BILLABLE_NODE_TYPES`.
14. [`src/v2/runner/workflowRunner.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/runner/workflowRunner.js) — Added `"video-generation"` to `PROVIDER_BACKED_NODE_TYPES`.
15. [`src/platform/media/MediaLifecycleService.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/media/MediaLifecycleService.js) — Added `"video-generation"` to `PROVIDER_BACKED_NODE_TYPES`.
16. [`package.json`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/package.json) — Included `tests/boundary/apiRoutingBoundary.test.js` in `npm test`.
17. [`tests/boundary/apiRoutingBoundary.test.js`](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/tests/boundary/apiRoutingBoundary.test.js) **[NEW]** — Automated boundary tests for routing separation.

### Frontend (`my-app`):
1. [`src/features/workflows/api/workflowsApi.js`](file:///c:/Users/jihad/Desktop/open%20art/my-app/src/features/workflows/api/workflowsApi.js) — Cleaned `useGenerateMutation` to explicitly dispatch:
   - `isVideo ? '/video/generated' : '/images/generated'`.
2. [`src/app/cinema-studio/[projectId]/generations/page.js`](file:///c:/Users/jihad/Desktop/open%20art/my-app/src/app/cinema-studio/%5BprojectId%5D/generations/page.js) — Ensured `references: request.references || []` is forwarded in generation payload.

---

## 7. Test Results

### Backend (`apiOpenArt`):
Command:
```bash
npm test
```
Result:
```text
# tests 127
# suites 16
# pass 127
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 845.3921
```

### Frontend (`my-app`):
Command:
```bash
node --test src/features/prompt-bar/__tests__/*.test.mjs
```
Result:
```text
# tests 40
# suites 0
# pass 40
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 136.5478
```

---

## 8. Remaining Legacy Dependencies (Documented & Isolated)

The following callsites exist in `my-app` for edit and video-editing features that are currently deferred:
- **`useExtendVideoMutation`** (`src/features/workflows/api/workflowsApi.js:L380`): Targets `/video/extend`. Used exclusively in `useEditPromptBar.js` for the edit page.
- **`useEditPromptBar.js` Camera & Lighting Tabs**: Call `useGenerateMutation` with `isCamera: true` or `isLighting: true`.

*These editor tabs are completely outside the active Generated Image / Generated Video foundation and will be implemented in dedicated future milestones.*
