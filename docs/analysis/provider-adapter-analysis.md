# The Provider as a Model Execution Adapter in SaaS AI

> **Scope**: Provider layer ONLY — not Treatment, not Router, not Workflow, not Wallet.  
> **Analogy**: The Provider is the **Driver**; the Model is the **Engine**; the Treatment is the **Brain**.  
> **Project**: OpenArt API (`apiOpenArt`)  
> **Date**: Juin 2026

---

## What is a Provider? (One-sentence definition)

> A **Provider** is a thin, stateless adapter that takes a normalized request, calls an external AI API, waits for the result, and returns a normalized output. Nothing more.

---

## The Three Jobs of a Provider

A provider does exactly **3 things** and nothing else:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROVIDER = ADAPTER                                  │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                    │
│  │   adapt()    │ →  │ toPayload()  │ →  │  generate()  │                    │
│  │              │    │              │    │              │                    │
│  │ UI Form →    │    │ Internal →   │    │ HTTP POST →  │                    │
│  │ Internal     │    │ API JSON     │    │ Polling →    │                    │
│  │              │    │              │    │ Result       │                    │
│  └──────────────┘    └──────────────┘    └──────────────┘                    │
│                                                                             │
│  The Provider is a DUMB pipe. It does NOT decide. It does NOT think.        │
│  It only TRANSLATES and EXECUTES.                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The Provider Interface (What it MUST have)

```javascript
// Every Provider instance must expose these:
interface Provider {
  // ── Identity ──
  modelName: string;        // "google/nano-banana/text-to-image"
  provider: string;         // "wavespeed", "google", "replicate", "fal"
  type: string;             // "t2i", "i2i", "t2v", "i2v"
  
  // ── The Three Jobs ──
  adapt(form): object;      // 1. UI form → internal format
  toPayload(adapted): object; // 2. internal → API-specific JSON
  generate(payload): Promise<{ image_url?: string, video_url?: string, ... }>; // 3. Execute
}
```

**Note**: The Provider does NOT implement `execute()`, `run()`, `prepare()`, `hold()`, `commit()`, or `rollback()`. Those belong to the **Treatment**.

---

## The Three Jobs Explained with Code

### Job 1: `adapt(form)` — UI Form → Internal Format

**What it does**: Takes the messy UI form (mixed naming conventions, optional fields, user input) and converts it to a clean, internal representation.

```javascript
// User sends this from frontend:
const uiForm = {
  prompt: "a cat",
  ratio: "16:9",           // UI calls it "ratio"
  quality: "2k",            // UI calls it "quality"
  negativePrompt: "blurry",
  references: [{ url: "https://..." }],  // UI sends array of objects
};

// Provider.adapt(uiForm) → clean internal object:
const internal = provider.adapt(uiForm);
// → {
//   prompt: "a cat",
//   aspectRatio: "16:9",    // renamed
//   resolution: "2k",        // renamed
//   negativePrompt: "blurry",
//   images: ["https://..."],  // extracted URLs
//   outputFormat: "png",
// }
```

**Why this step exists**: Different UIs send different field names. The Provider normalizes them before building the API payload.

---

### Job 2: `toPayload(adapted)` — Internal Format → API JSON

**What it does**: Converts the clean internal object into the **exact JSON format** the external AI API expects.

```javascript
// Internal object from adapt():
const internal = {
  prompt: "a cat",
  aspectRatio: "16:9",
  resolution: "2k",
  negativePrompt: "blurry",
  images: ["https://..."],
  outputFormat: "png",
};

// Wavespeed provider.toPayload(internal) → exact JSON for Wavespeed API:
const payload = wavespeedProvider.toPayload(internal);
// → {
//   prompt: "a cat",
//   aspect_ratio: "16:9",       // ← Wavespeed uses snake_case
//   resolution: "2k",             // ← Wavespeed calls it "resolution" not "quality"
//   negative_prompt: "blurry",   // ← snake_case
//   images: ["https://..."],    // ← Wavespeed expects array of URLs
//   output_format: "png",         // ← snake_case
// }

// Google provider.toPayload(internal) → different JSON:
const googlePayload = googleProvider.toPayload(internal);
// → {
//   contents: [{ role: "user", parts: [{ text: "a cat" }] }], // ← Google uses "contents"
//   generationConfig: { aspectRatio: "16:9" },                  // ← camelCase
//   safetySettings: [...],                                      // ← Google-specific
// }
```

**Why this step exists**: Every external AI API has its own JSON schema. The Provider knows the schema of **its** API.

---

### Job 3: `generate(payload)` — Execute HTTP Call + Polling

**What it does**: Makes the HTTP request to the external API, handles async polling if needed, and returns a normalized result.

```javascript
// Wavespeed provider.generate(payload):
async generate(payload) {
  // 1. POST to external API
  const { taskId, pollUrl } = await this._submit(payload);
  
  // 2. Poll until done (async jobs take 5-30s)
  const url = await this._poll({ taskId, pollUrl });
  
  // 3. Return NORMALIZED result
  return { image_url: url };
  //              ↑
  // Every provider MUST return the same shape, regardless of API
}
```

**Key insight**: No matter which provider (Wavespeed, Google, Replicate, FAL), the return shape is always the same:
```javascript
// ALL providers return one of these shapes:
{ image_url: "..." }     // for image generation
{ video_url: "..." }     // for video generation
{ url: "..." }           // generic
{ output: { url: "..." } } // nested
```

The `extractOutputUrl()` helper in `providerStrategy.js` handles all these variations.

---

## What the Provider is NOT

The Provider is **NOT** any of these. If it starts doing these, it has leaked business logic:

| ❌ Not This | ✅ Who Does It | Why |
|-------------|---------------|-----|
| **Wallet check** | Treatment | Provider doesn't know credits exist |
| **DB writes** | Treatment | Provider doesn't know what a "workflow" is |
| **Queue management** | Treatment | Provider doesn't know what BullMQ is |
| **Prompt enhancement** | PromptService | Provider receives the FINAL prompt only |
| **Safety moderation** | PromptService | Provider receives pre-approved content only |
| **Storage upload** | Treatment | Provider returns a URL; Treatment uploads to Supabase |
| **Cost calculation** | ModelRouter | Provider doesn't know what "credits" are |
| **Retry logic** | Treatment or Worker | Provider may retry HTTP calls but not business logic |
| **Error handling for user** | Treatment | Provider throws raw errors; Treatment translates them |

---

## Provider Examples (Real Code from OpenArt)

### Example 1: WavespeedImageRunner (Image Provider)

```javascript
class WavespeedImageRunner extends BaseModel {
  // ── Identity ──
  modelName = "google/nano-banana/text-to-image";
  provider = "wavespeed";
  type = "t2i";
  
  // ── Job 1: adapt ──
  adapt(form) {
    return {
      prompt:         form.prompt,
      aspectRatio:    form.aspectRatio || form.ratio || "1:1",
      resolution:     form.quality || form.resolution || "1k",
      negativePrompt: form.negativePrompt,
      outputFormat:   "png",
    };
  }
  
  // ── Job 2: toPayload ──
  toPayload({ prompt, aspectRatio, resolution, negativePrompt, outputFormat }) {
    return {
      prompt,
      aspect_ratio:    aspectRatio || "1:1",
      resolution:      String(resolution || "1k").toLowerCase(),
      negative_prompt: negativePrompt || "",
      output_format:   outputFormat || "png",
    };
  }
  
  // ── Job 3: generate ──
  async generate(payload) {
    const policy = resolveExecutionPolicy(payload, { type: "image", provider: this.provider, model: this.modelName });
    const { taskId, pollUrl } = await this._submit(payload, policy);  // POST
    const url = await this._poll({ taskId, pollUrl, policy });       // GET until done
    return { image_url: url };
  }
}
```

### Example 2: Google Image Provider (Hypothetical, but same pattern)

```javascript
class GoogleImageRunner extends BaseModel {
  modelName = "imagen-4";
  provider = "google";
  type = "t2i";
  
  adapt(form) {
    // Same interface as Wavespeed:
    return {
      prompt: form.prompt,
      aspectRatio: form.ratio || "1:1",
      resolution: form.quality || "1k",
      negativePrompt: form.negativePrompt,
    };
  }
  
  toPayload({ prompt, aspectRatio, resolution }) {
    // Different JSON format for Google API:
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        aspectRatio: aspectRatio,
        imageQuality: resolution === "4k" ? "premium" : "standard",
      },
    };
  }
  
  async generate(payload) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/imagen-4:generate", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.GOOGLE_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    return { image_url: json.candidates[0].content.parts[0].inlineData.data }; // Google returns base64
  }
}
```

### Example 3: Replicate Video Provider (Hypothetical)

```javascript
class ReplicateVideoRunner extends BaseModel {
  modelName = "kling-v3";
  provider = "replicate";
  type = "t2v";
  
  adapt(form) {
    return {
      prompt: form.prompt,
      aspectRatio: form.ratio || "16:9",
      duration: parseInt(form.duration) || 5,
      resolution: form.video_resolution || "720p",
    };
  }
  
  toPayload({ prompt, aspectRatio, duration, resolution }) {
    return {
      version: "kling-v3-model-hash",  // Replicate uses version hashes
      input: {
        prompt,
        aspect_ratio: aspectRatio,
        seconds: duration,
        resolution: resolution === "1080p" ? 1080 : 720,
      },
    };
  }
  
  async generate(payload) {
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { "Authorization": `Token ${process.env.REPLICATE_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const prediction = await res.json();
    
    // Replicate returns a prediction URL; we poll it
    const result = await pollReplicatePrediction(prediction.id);
    return { video_url: result.output };  // ← normalized to video_url
  }
}
```

---

## How the Provider is Used by the Treatment

```javascript
// In BaseGenerateImageTreatment.js:

// 1. Resolve the provider (ModelRouter + ProviderStrategy)
const provider = this._resolveProvider(model_name, input_assets);
// → returns: WavespeedImageRunner instance (or GoogleImageRunner, etc.)

// 2. Build the form
const form = {
  prompt: finalPrompt,
  negativePrompt: finalNegative,
  ratio, quality,
  image: sourceAsset?.url,     // for i2i
  references: input_assets,     // for multi-ref
};

// 3. The Provider does its 3 jobs
const payload = this._buildPayload(provider, form);  // adapt + toPayload
const result = await provider.generate(payload);      // HTTP call
const outputUrl = extractOutputUrl(result);            // { image_url: "..." }

// 4. The Treatment does what the Provider does NOT do
const fileName = `${userId}/generations/${workflow.id}_${Date.now()}.png`;
const fileUrl = await this.storageService.uploadFromUrl(fileName, outputUrl);  // ← Storage
await this.db.media.updateFields(mediaId, { url: fileUrl });                    // ← DB
await markMediaStatus(this.db, mediaId, "success");                            // ← DB
// ... wallet commit, etc.
```

---

## How to Add a New Provider (No Treatment Changes Needed)

To add a new provider (e.g., `fal.ai`), you only need to:

1. **Create the Runner class** (extends BaseModel):
   ```javascript
   // src/image/runners/fal/models/my-model.js
   class FalImageRunner extends BaseModel {
     modelName = "fal-ai/flux-lora";
     provider = "fal";
     type = "t2i";
     
     adapt(form) { /* normalize */ }
     toPayload(adapted) { /* fal.ai JSON format */ }
     async generate(payload) { /* HTTP to fal.ai */ }
   }
   ```

2. **Register in the Provider's Registry**:
   ```javascript
   // src/image/runners/fal/registry.js
   export const MODELS = {
     "flux_lora_fal": {
       displayName: "FLUX LoRA",
       t2i: new FalImageRunner(),
       pricing: { per_image: 0.03 },
     }
   };
   ```

3. **Add a Route in the ModelRouter**:
   ```javascript
   // src/image/core/modelRouter.js
   "flux_lora": fromRegistry("flux_lora_fal", false, false, IMAGE_MODEL_TYPES.GENERATED, {
     table: { generated: { standard: 5, hd: 8 } }
   }),
   ```

**Done.** The Treatment, Wallet, DB, Workflow, Queue — none of them change. The new model is available immediately because the Provider is just an adapter.

---

## The Provider as a "Dumb Pipe" — Why This Matters

```
WRONG (Leaked Business Logic):
┌─────────────────────────────────────────┐
│  OpenAIService                          │
│  • generateImage()                        │
│  • checkWallet()          ← ❌          │
│  • saveToDB()             ← ❌          │
│  • calculateCredits()     ← ❌          │
│  • retryWithQueue()       ← ❌          │
│  • uploadToStorage()      ← ❌          │
└─────────────────────────────────────────┘
→ If you switch from OpenAI to Midjourney, you rewrite everything.

CORRECT (Provider as Adapter):
┌─────────────────────────────────────────┐
│  Treatment (Brain)                        │
│  • checkWallet()                          │
│  • saveToDB()                             │
│  • calculateCredits()                     │
│  • retryWithQueue()                       │
│  • uploadToStorage()                      │
│  • THEN call: provider.generate()         │
└──────────────────┬──────────────────────┘
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
┌──────────────┐      ┌──────────────┐
│  Provider A  │      │  Provider B  │
│  (Wavespeed) │      │  (Google)    │
│  • adapt()   │      │  • adapt()   │
│  • toPayload │      │  • toPayload │
│  • generate()│      │  • generate()│
└──────────────┘      └──────────────┘
→ Switching providers = swapping one adapter. Nothing else changes.
```

---

## Summary: The Provider in One Table

| Question | Answer |
|----------|--------|
| **What is the Provider?** | A thin adapter between the Treatment and an external AI API |
| **What does it do?** | `adapt()` → `toPayload()` → `generate()` |
| **What does it NOT do?** | Wallet, DB, Queue, Storage, Business Logic, Retry |
| **How many jobs?** | Exactly 3. No more. |
| **Is it stateful?** | No. Stateless. Only holds API key and model name. |
| **Does it know the user?** | No. Receives `userId` only for filename generation, not logic. |
| **Does it know credits?** | No. The Treatment decides the cost BEFORE calling the Provider. |
| **Can I swap providers?** | Yes. Zero changes to Treatment, Wallet, DB, or Workflow. |
| **Does it handle errors?** | Raw HTTP errors only. The Treatment handles user-facing errors. |
| **Does it retry?** | HTTP-level retry only (e.g., timeout). Business retry is Treatment's job. |

---

## The Golden Rule

> If your Provider starts importing `WalletService`, `BullMQ`, or `Supabase`, you have leaked business logic into the wrong layer. The Provider should only import `node-fetch` (or equivalent) and its own API key.

---

*Document focused specifically on the Provider layer as a Model Execution Adapter in the OpenArt SaaS architecture.*
