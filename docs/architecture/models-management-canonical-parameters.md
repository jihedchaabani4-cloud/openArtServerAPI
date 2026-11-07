# Models Management — Canonical Parameter Architecture

This document defines the canonical parameter vocabulary and provider mapping architecture for the OpenArt Models Management Subsystem.

---

## 1. Core Architecture & Layer Ownership

The platform decouples public caller interfaces from internal provider API schemas using a two-sided declarative architecture:

```
Provider API Payload
         ▲
         │ (parameterMap, valueMap, transforms)
Provider Binding Manifest (bindings/<provider>.json)
         ▲
         │ (declared in canonicalInputs)
Authoritative Model Manifest (model.json)
         │
         ▼ (GET /api/models -> parameters: canonicalInputs)
Frontend / Workflow Node Layer
```

### Layer Responsibilities & Ownership

1. **Provider API Layer (`runtime/<provider>/`)**:
   - Owns external network protocols and native payload schemas (e.g. WaveSpeed REST/SDK, Google GenAI SDK).
   - Zero awareness of platform workflows, UI state, or credit billing.
2. **Provider Binding Layer (`manifests/<model>/bindings/<provider>.json`)**:
   - **Sole owner** of the translation from Canonical Semantic Parameters $\to$ Provider Payload Fields.
   - Declaratively specifies `providerField`, `valueMap` (enum remapping), and `transform` (`wrap_array`).
   - Declares execution route selection rules (`when: { input_image: "present" }`).
3. **Canonical Model Layer (`manifests/<model>/model.json`)**:
   - **Sole authoritative source of truth** for model parameters (`canonicalInputs`) and capabilities.
   - Defines parameter type, default values, min/max constraints, and allowed values.
   - Strictly domain-semantic: zero provider field names or provider operational taxonomy leaks.
4. **Frontend / Feature Layer (`my-app`)**:
   - Consumes only canonical model definitions via `GET /api/models`.
   - Feature concepts (e.g. *Start Frame*, *End Frame*, *Reference Shelf*) map to canonical parameter keys (`input_image`, `last_frame`, `images`).
   - Zero awareness of provider field names (`image`, `last_image`, `sourceImage`, etc.).

---

## 2. Canonical Parameter Rules

Two parameters from different models or providers are unified under the same canonical name **ONLY** when all six criteria are satisfied:

1. **Same Real Concept**: They represent the exact same semantic intent (e.g. audio generation toggle, primary source image).
2. **Same Input Role**: They fulfill the identical functional role in the media generation lifecycle.
3. **Compatible Type**: Both are strings, both are numbers, or both are booleans (e.g. a boolean flag cannot be unified with a string enum).
4. **Compatible Cardinality**: Both are scalars (cardinality 1) or both are arrays.
5. **Compatible Lifecycle**: Both are created, modified, and validated under the same execution rules.
6. **Compatible Execution Semantics**: Changing the value produces an equivalent generation outcome across models.

---

## 3. Canonical Vocabulary Reference

The authoritative canonical vocabulary across domains:

| Canonical Name | Domain | Type | Cardinality | Semantic Role | Provider Field Examples | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `prompt` | All | `string` | 1 | Primary text prompt | `prompt` (WaveSpeed), `textPrompt` (Google), `contents` (Gemini) | Universal required parameter |
| `negative_prompt`| Image | `string` | 1 | Elements to avoid | `negativePrompt` (Google) | Negative conditioning |
| `input_image` | Image, Video, Upscale | `string` (URL) | 1 | Primary source image | `image` (WaveSpeed video/upscale), `sourceImage` (Google), `images` (WaveSpeed edit via `wrap_array`) | **Never** conflated with `images` |
| `last_frame` | Video | `string` | 1 | Video end keyframe | `last_image` (WaveSpeed) | Used for start-to-end frame continuation |
| `images` | Image, LLM | `array` | 2–16 | Multi-reference images | `images` (Google Gemini, WaveSpeed) | Strictly an array for reference/guidance |
| `input_video` | Video | `string` (URL) | 1 | Video clip to extend | `video` (WaveSpeed) | Video extension/continuation source |
| `duration` | Video | `number` | 1 | Video length (seconds)| `duration` (WaveSpeed) | Allowed enum values e.g. 5, 10 |
| `resolution` | Image, Video | `string` | 1 | Resolution tier | `resolution` (WaveSpeed), `imageSize` (Google via `valueMap`) | e.g. 720p, 1080p, 1k, 2k, 4k |
| `aspect_ratio` | Image, Video | `string` | 1 | Aspect ratio | `aspect_ratio` (WaveSpeed), `aspectRatio` (Google) | e.g. 16:9, 9:16, 1:1, 4:3 |
| `generate_audio`| Video | `boolean` | 1 | Synchronized audio | `generate_audio` (Seedance), `enable_audio` (Wan) | Canonical audio toggle for video |
| `output_format` | Image | `string` | 1 | Output container | `output_format` (WaveSpeed) | e.g. png, jpeg, webp |
| `scale_factor` | Upscale | `number` | 1 | Resolution factor | `target_resolution` (WaveSpeed via `valueMap`) | 2, 4, 8 |

---

## 4. Strict Media Invariants

To guarantee deterministic model switching and execution safety:

```
┌─────────────────────────────────────────────────────────────┐
│                      MEDIA INVARIANTS                       │
│                                                             │
│       images       ≠     input_image     ≠    last_frame    │
│  (Reference Array)    (Primary/Start)        (End Frame)    │
└─────────────────────────────────────────────────────────────┘
```

1. **`images` is strictly an array** representing multi-image visual references.
2. **`input_image` is strictly a scalar string** representing the single primary source, edit target, or video start frame.
3. **`last_frame` is strictly a scalar string** representing the video continuation ending keyframe.
4. **No cross-population**:
   - Switching from a multi-reference model to a single-image model prunes `images`. It does **not** inject `images[0]` into `input_image`.
   - Switching from a single-image model to a multi-reference model prunes `input_image`. It does **not** inject `input_image` into `images`.
   - Switching from a Frames model to an Image model preserves keyframe values independently without contaminating reference arrays.

---

## 5. Real Model Mapping Examples

### Example 1: Audio Canonicalization Across Providers (`wan_3_0` vs `seedance_2_5`)
- In `seedance_2_5` (WaveSpeed native field is `generate_audio`):
  ```json
  "generate_audio": {
    "providerField": "generate_audio",
    "type": "boolean"
  }
  ```
- In `wan_3_0` (WaveSpeed native field is `enable_audio`):
  ```json
  "generate_audio": {
    "providerField": "enable_audio",
    "type": "boolean"
  }
  ```
*Caller supplies `{ generate_audio: true }` in both cases; provider bindings handle payload differences declaratively.*

### Example 2: Video Frames Mapping (`seedance_2_5`)
- Caller supplies:
  ```json
  {
    "prompt": "sunset to starfield",
    "input_image": "https://example.com/start.png",
    "last_frame": "https://example.com/end.png"
  }
  ```
- Binding mapping:
  ```json
  "input_image": { "providerField": "image" },
  "last_frame": { "providerField": "last_image" }
  ```
- Provider payload transmitted:
  ```json
  {
    "prompt": "sunset to starfield",
    "image": "https://example.com/start.png",
    "last_image": "https://example.com/end.png"
  }
  ```

### Example 3: Scalar to Array Transformation (`nanobana_pro` Edit)
- Caller supplies:
  ```json
  {
    "prompt": "recolor jacket to navy",
    "input_image": "https://example.com/jacket.png"
  }
  ```
- Binding mapping:
  ```json
  "input_image": {
    "providerField": "images",
    "type": "string",
    "transform": "wrap_array"
  }
  ```
- Provider payload transmitted:
  ```json
  {
    "prompt": "recolor jacket to navy",
    "images": [
      "https://example.com/jacket.png"
    ]
  }
  ```

### Example 4: Enum Translation via `valueMap` (`wavespeed_upscale`)
- Caller supplies:
  ```json
  {
    "input_image": "https://example.com/low.png",
    "scale_factor": 2
  }
  ```
- Binding mapping:
  ```json
  "scale_factor": {
    "providerField": "target_resolution",
    "valueMap": {
      "2": "2k",
      "4": "4k",
      "8": "8k"
    }
  }
  ```
- Provider payload transmitted:
  ```json
  {
    "image": "https://example.com/low.png",
    "target_resolution": "2k"
  }
  ```
