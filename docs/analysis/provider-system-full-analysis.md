# OpenArt Provider Architecture — Full Server Analysis

> **Project**: OpenArt API (`apiOpenArt`)  
> **Scope**: AI Model Provider System — How models are registered, resolved, parameterized, priced, and executed  
> **Stack**: Node.js ESM, Express 4, Provider APIs (Wavespeed, Replicate, Google, FAL, OpenAI, Groq)  
> **Date**: Juin 2026

---

## Table des matières

1. [Vue d'ensemble architecturale](#1-vue-densemble-architecturale)
2. [Couche 1: Registry — Où les modèles sont définis](#2-couche-1-registry--où-les-modèles-sont-définis)
3. [Couche 2: Model Router — Comment on choisit un modèle](#3-couche-2-model-router--comment-on-choisit-un-modèle)
4. [Couche 3: Provider Strategy — Comment on résout le provider](#4-couche-3-provider-strategy--comment-on-résout-le-provider)
5. [Couche 4: Runner — Comment on appelle l'API externe](#5-couche-4-runner--comment-on-appelle-lapi-externe)
6. [Couche 5: Treatment — Le workflow métier complet](#6-couche-5-treatment--le-workflow-métier-complet)
7. [Système de crédits (Pricing)](#7-système-de-crédits-pricing)
8. [Provider Registry Global (Feature 008)](#8-provider-registry-global-feature-008)
9. [Diagramme de flux complet](#9-diagramme-de-flux-complet)
10. [Points forts et faiblesses](#10-points-forts-et-faiblesses)

---

## 1. Vue d'ensemble architecturale

L'architecture provider d'OpenArt suit un pattern **Registry → Router → Strategy → Runner** avec 5 couches clairement séparées:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COUCHE 5: TREATMENT                                  │
│  BaseGenerateImageTreatment / VideoTreatment                                │
│  • Prépare les données (DB, wallet, config)                                   │
│  • Optimise le prompt (sécurité, enhancement)                                 │
│  • Ordonne l'exécution (BullMQ worker)                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                         COUCHE 4: MODEL ROUTER                               │
│  image/core/modelRouter.js  /  video/core/modelRouter.js                     │
│  • Registre des modèles publics → runners internes                            │
│  • Calcule les crédits (prix)                                               │
│  • Résout le runner selon le mode (t2i, i2i, t2v, i2v...)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                         COUCHE 3: PROVIDER STRATEGY                          │
│  providerStrategy.js                                                         │
│  • Choisit le variant (t2i vs i2i) selon les références                       │
│  • Construit le payload (adapt → toPayload)                                  │
│  • Extrait l'URL de sortie                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                         COUCHE 2: RUNNER                                     │
│  WavespeedImageRunner / ReplicateRunner / GoogleRunner...                    │
│  • Adapte le formulaire utilisateur au format provider                      │
│  • Appelle l'API externe (HTTP POST + polling)                              │
│  • Retourne l'URL de l'image/vidéo générée                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                         COUCHE 1: PROVIDER API                               │
│  Wavespeed AI, Replicate, Google AI, FAL.ai, OpenAI, Groq...                │
│  • Services externes qui génèrent réellement le média                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Couche 1: Registry — Où les modèles sont définis

### 2.1 Structure du Registry (par provider)

**Fichier**: `src/image/runners/wavespeed/registry.js`

Chaque provider (Wavespeed, Replicate, Google) a son propre registry qui exporte un objet `MODELS`. Chaque modèle est un **ModelGroup** qui contient plusieurs runners (t2i, i2i, i2iMulti).

```javascript
// Extrait de wavespeed/registry.js
export const MODELS = {
    "nanobana_wavespeed": {
        displayName: "NanoBanana",
        icon: IMAGE_ICONS.nanobana,
        description: "Fast affordable image generation",
        category: "image", tier: "std",
        pricing:  { per_image: 0.05 },        // Prix réel USD (pas credits)
        tags:     ["fast", "affordable"],
        support:  { ratio: ["1:1", "16:9"], quality: ["1k", "2k", "4k"], references: { min: 0, max: 8 } },
        t2i:      nanobana.normal,            // ← Runner instance (class)
        i2i:      nanobana.edit,              // ← Runner instance (class)
    },
    "nanobana2_wavespeed": {
        displayName: "NanoBanana 2",
        pricing:  { per_image: 0.07 },
        support:  { ratio: [...], quality: ["1k", "2k", "4k"], references: { min: 0, max: 14 } },
        t2i:      nanobana.nb2T2i,
        i2i:      nanobana.nb2Edit,
        i2iMulti: nanobana.nb2Edit,           // ← Support multi-references
    },
    // ... etc
};
```

### 2.2 Structure du Registry Video

**Fichier**: `src/video/runners/wavespeed/registry.js`

Même pattern mais avec les modes vidéo: `t2v`, `i2v`, `i2v_se`, `motion`, `r2v`, `v2v`.

```javascript
export const MODELS = {
    "kling_v3_wavespeed": {
        t2v:      kling_v3.t2v,       // text-to-video
        i2v:      kling_v3.i2v,       // image-to-video
        i2v_se:   kling_v3.i2v_se,    // image-to-video + end frame
        motion:   kling_v3.motion,     // motion brush
        r2v:      kling_v3.r2v,       // reference-to-video
        v2v:      kling_v3.v2v,       // video-to-video (edit)
        _default: kling_v3.t2v,       // fallback
    },
};
```

### 2.3 Key insight: Séparation Provider/Model

```
Registry interne:          Route publique:
"nanobana_wavespeed"   →   "nanobana"         (friendly name pour le user)
"kling_v3_wavespeed"   →   "kling_v3"         (friendly name pour le user)
```

Le `modelRouter.js` fait le mapping entre la clé publique (ce que l'user voit) et la clé interne (ce que le registry utilise).

---

## 3. Couche 2: Model Router — Comment on choisit un modèle

### 3.1 Image Model Router

**Fichier**: `src/image/core/modelRouter.js` (378 lignes)

Le router fait 3 choses:
1. **Agrège tous les registries** (wavespeed + fal + replicate + google)
2. **Crée `IMAGE_ROUTES`** — mapping public_key → { t2i, i2i, pricing, type }
3. **Calcule les crédits** — `calculateImageCredits()`

```javascript
// 1. Import de tous les registries
import { MODELS as wavespeedModels } from "#image/runners/wavespeed/registry.js";
import { MODELS as falModels } from "#image/runners/fal/registry.js";
import { MODELS as replicateModels } from "#image/runners/replicate/registry.js";
import { MODELS as googleModels } from "#image/runners/google/registry.js";

const ALL_REGISTRY_MODELS = {
    ...wavespeedModels,
    ...falModels,
    ...replicateModels,
    ...googleModels,
};

// 2. Fonction fromRegistry() — crée une route publique
function fromRegistry(key, supportsEdit, supportsCamera, type, pricing, isOpen, isHidden, overrides) {
    const group = ALL_REGISTRY_MODELS[key];
    return {
        t2i:      group.t2i || null,
        i2i:      group.i2i || null,
        i2iMulti: group.i2iMulti || null,
        group,                       // ← référence au ModelGroup complet
        type,                        // "generated" | "upscale"
        open: isOpen,                // visible aux users ?
        hidden: isHidden,            // backend-only ?
        supportsEdit,
        supportsCamera,
        pricing: {
            generatedBaseCredits: 10,
            editBaseCredits: 10,
            upscaleBaseCredits: 6,
            qualityMultipliers: { standard: 1, hd: 1, "1k": 1, "2k": 1.5, "4k": 2.5 },
            ...pricing,
        },
        ...overrides,
    };
}

// 3. Les routes publiques
export const IMAGE_ROUTES = {
    "nanobana": fromRegistry("nanobana_wavespeed", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {                                  // ← PRICING EXACT (pas de formule)
            generated: { standard: 8,  hd: 11, "2k": 16, "4k": 26 },
            edit:      { standard: 9,  hd: 12, "2k": 18, "4k": 30 },
        }
    }),
    "imagen_4": fromRegistry("imagen_4_google", false, false, IMAGE_MODEL_TYPES.GENERATED, {
        table: {
            generated: { standard: 11, hd: 15, "2k": 22, "4k": 36 },
            edit:      { standard: 12, hd: 16, "2k": 24, "4k": 40 },
        }
    }),
    // ... etc pour tous les modèles
};
```

### 3.2 Comment les crédits image sont calculés

```javascript
export function calculateImageCredits({ modelKey, quality = "standard", count = 1, operation = "generated" }) {
    const route = getImageModel(modelKey);
    const pricing = route.pricing || {};
    const qualityKey = normalizeQualityKey(quality);
    const quantity = Math.max(1, Number(count) || 1);
    const op = operation === "edit" ? "edit" : "generated";

    let credits = 0;

    // ── Méthode 1: Table exacte (prioritaire) ──
    // Ex: nanobana + generated + standard = 8 crédits exactement
    if (pricing.table && pricing.table[op] && pricing.table[op][qualityKey] !== undefined) {
        credits = roundCredits(pricing.table[op][qualityKey] * quantity);
    }
    // ── Méthode 2: Formule mathématique (fallback) ──
    // Ex: baseCredits(10) * qualityMultiplier(1.5) * count(2) = 30 crédits
    else {
        const baseCredits = op === "edit" ? pricing.editBaseCredits : pricing.generatedBaseCredits;
        const qualityMultiplier = pricing.qualityMultipliers?.[qualityKey] ?? 1;
        credits = roundCredits(baseCredits * qualityMultiplier * quantity);
    }

    return {
        credits,
        pricingVersion: "image-router-v1",
        breakdown: { modelKey, operation, quality: qualityKey, count: quantity },
    };
}
```

### 3.3 Video Model Router

**Fichier**: `src/video/core/modelRouter.js` (316 lignes)

Même pattern mais avec des dimensions supplémentaires: **duration** et **resolution**.

```javascript
export function calculateVideoCredits({ modelKey, durationSeconds = 5, resolution = "720p", count = 1 }) {
    const route = MODEL_ROUTES[modelKey];
    const pricing = route.pricing || {};
    const seconds = normalizeDurationSeconds(durationSeconds);
    const resolutionKey = normalizeResolutionKey(resolution);
    const quantity = Math.max(1, Number(count) || 1);

    let credits = 0;

    // ── Méthode 1: Table exacte ──
    // Ex: kling_v3 + 720p + 5s = 42 crédits
    if (pricing.table && pricing.table[resolutionKey] && pricing.table[resolutionKey][seconds] !== undefined) {
        credits = roundCredits(pricing.table[resolutionKey][seconds] * quantity);
    }
    // ── Méthode 2: Formule mathématique ──
    // Ex: base(20) + perSecond(4) * 5s = 40 * resolutionMultiplier(1.6 for 1080p) = 64 crédits
    else {
        const baseCredits = pricing.baseCredits ?? 20;
        const perSecondCredits = pricing.perSecondCredits ?? 4;
        const resolutionMultiplier = pricing.resolutionMultipliers?.[resolutionKey] ?? 1;
        credits = roundCredits((baseCredits + perSecondCredits * seconds) * resolutionMultiplier * quantity);
    }

    return { credits, pricingVersion: "video-router-v1", breakdown: {...} };
}
```

### 3.4 Exemple de pricing table (vidéo)

```javascript
// Kling v3 — prix exacts par résolution × durée
"kling_v3": fromRegistry("kling_v3_wavespeed", "Kling v3.0", false, true, VIDEO_MODEL_TYPES.GENERATED, {
    table: {
        "720p":  { 3: 25, 5: 42, 10: 84, 15: 126 },   // 5s@720p = 42 crédits
        "1080p": { 3: 35, 5: 60, 10: 120, 15: 180 },  // 5s@1080p = 60 crédits
    }
}),

// Runway Gen-4
"runway_gen4_turbo": fromRegistry("runway_gen4_turbo_wavespeed", "RunwayML Gen-4 Turbo", false, true, VIDEO_MODEL_TYPES.GENERATED, {
    table: {
        "720p":  { 5: 75, 10: 150 },
        "1080p": { 5: 100, 10: 200 },
    }
}),
```

---

## 4. Couche 3: Provider Strategy — Comment on résout le provider

### 4.1 Résolution du provider

**Fichier**: `src/image/treatments/basetretment/providerStrategy.js`

```javascript
export function resolveProvider({ model_name, input_assets = [], models = {} }) {
    const route = getImageModel(model_name);          // 1. Récupère la route publique
    const modelGroup = route?.group || models[model_name];

    // 2. Détermine le variant selon les références
    const hasRefs = (input_assets?.length ?? 0) > 0;
    const isMulti = (input_assets?.length ?? 0) > 1;
    const variantKey = hasRefs ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

    // 3. Cherche le runner dans la route
    const provider =
        route?.[variantKey] ||           // t2i / i2i / i2iMulti
        (hasRefs && route?.i2i) ||
        route?.t2i ||
        modelGroup?.[variantKey] ||
        modelGroup?.i2i ||
        modelGroup?.t2i ||
        modelGroup;

    if (!provider) throw new Error(`Provider not found for model "${model_name}"`);
    return provider;
}
```

### 4.2 Construction du payload

```javascript
export function buildProviderPayload(provider, form) {
    // Méthode 1: Runner a une méthode buildPayload()
    if (typeof provider.buildPayload === "function") {
        return provider.buildPayload(form);
    }

    // Méthode 2: Runner a adapt() + toPayload()
    if (typeof provider.adapt === "function") {
        const adapted = provider.adapt(form);
        return typeof provider.toPayload === "function"
            ? provider.toPayload(adapted)
            : adapted;
    }

    // Méthode 3: Pass-through (rare)
    return form;
}
```

### 4.3 Extraction de l'URL de sortie

```javascript
export function extractOutputUrl(result = {}) {
    return (
        result.image_url ||
        result.url ||
        result.outputUrl ||
        result.output?.url ||
        (Array.isArray(result.output) ? result.output[0] : null)
    );
}
```

---

## 5. Couche 4: Runner — Comment on appelle l'API externe

### 5.1 BaseModel (classe parente)

**Fichier**: `src/core/BaseModel.js` (non lu mais déduit des enfants)

Tous les runners héritent de `BaseModel` qui expose:
- `modelName` — nom technique du modèle côté provider
- `provider` — identifiant du provider ("wavespeed", "replicate", "google")
- `type` — "t2i", "i2i", "t2v", "i2v"...
- `adapt(form)` — transforme le formulaire utilisateur en format interne
- `toPayload(adapted)` — transforme le format interne en JSON pour l'API

### 5.2 WavespeedImageRunner

**Fichier**: `src/image/runners/wavespeed/WavespeedImageRunner.js`

```javascript
const BASE = "https://api.wavespeed.ai/api/v3";

export class WavespeedImageRunner extends BaseModel {
    constructor(options) {
        super(options);
        this.apiKey = process.env.WAVESPEED_API_KEY;
    }

    // ━━━ 1. Soumettre la tâche ━━━
    async _submit(payload, policy) {
        const res = await fetch(`${BASE}/${this.modelName}`, {
            method:  "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type":  "application/json"
            },
            body:   JSON.stringify(payload),
            signal: createTimeoutSignal(policy.requestTimeoutMs)
        });

        const json = await res.json();
        const taskId = json.data?.id || json.data?.task_id;
        const pollUrl = json.data?.urls?.get || null;
        return { taskId, pollUrl };
    }

    // ━━━ 2. Polling jusqu'à completion ━━━
    async _poll({ taskId, pollUrl, policy }) {
        const start = Date.now();
        const MAX_ATTEMPTS = Math.floor(policy.maxDurationMs / policy.pollIntervalMs);
        const url = pollUrl || `${BASE}/predictions/${taskId}/result`;

        while (Date.now() - start < policy.maxDurationMs) {
            await sleep(policy.pollIntervalMs);

            const res = await fetch(url, {
                headers: { "Authorization": `Bearer ${this.apiKey}` },
            });
            const json = await res.json();
            const data = json.data || json;
            const status = data.status;
            const outputs = data.outputs || [];

            if (status === "succeeded" || status === "completed") {
                const out = outputs[0];
                return (typeof out === "object" && out?.url) ? out.url : out || null;
            }

            if (status === "failed") {
                throw new Error(`WaveSpeed failed: ${data.error || "unknown"}`);
            }
        }
        throw new Error(`Timeout after ${policy.maxDurationMs}ms`);
    }

    // ━━━ 3. Point d'entrée public ━━━
    async generate(payload) {
        const policy = resolveExecutionPolicy(payload, {
            type: "image", provider: this.provider, model: this.modelName,
        });
        const meta = await this._submit(payload, policy);
        const url = await this._poll({ ...meta, policy });
        return { image_url: url };
    }
}
```

### 5.3 Exemple concret: NanoBanana Normal (t2i)

**Fichier**: `src/image/runners/wavespeed/models/nanobana.js`

```javascript
class NanobanaNormal extends WavespeedImageRunner {
    constructor() {
        super({
            modelName: "google/nano-banana/text-to-image",   // ← nom API Wavespeed
            provider: "wavespeed",
            type: "t2i",
            maxReferences: 0,                                 // ← pas de références
            capabilities: [CAPS.TEXT, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            displayName: "NanoBanana",
            pricing: { image: 5 },                            // ← $0.05 par image (USD)
            modes: ["t2i"],
            supportedRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            supportedQualities: ["1k", "2k", "4k"],
            defaultParams: { ratio: "1:1", quality: "1k" },
        });
    }

    // Transforme le formulaire UI → format interne
    adapt(form) {
        return {
            prompt:         form.prompt,
            aspectRatio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt: form.negativePrompt,
            outputFormat:   "png",
        };
    }

    // Transforme le format interne → JSON API Wavespeed
    toPayload({ prompt, aspectRatio, resolution, negativePrompt, outputFormat }) {
        return {
            prompt,
            aspect_ratio:    aspectRatio || "1:1",
            resolution:      String(resolution || "1k").toLowerCase(),
            negative_prompt: negativePrompt || "",
            output_format:   outputFormat || "png",
        };
    }
}

export const normal = new NanobanaNormal();  // ← Instance singleton
```

### 5.4 Exemple: NanoBanana Edit (i2i avec références)

```javascript
class NanobanaEdit extends WavespeedImageRunner {
    constructor() {
        super({
            modelName: "google/nano-banana/edit",
            type: "i2i",
            maxReferences: 8,                               // ← jusqu'à 8 images
            capabilities: [CAPS.TEXT, CAPS.MULTI_IMAGE, CAPS.NEGATIVE, CAPS.OUTPUTS_IMAGE],
            modes: ["i2i"],
            hidden: true,                                    // ← pas visible dans l'UI directement
        });
    }

    adapt(form) {
        const refs = form.references || [];
        return {
            prompt:         form.prompt,
            images:         refs.map(r => r.url || r).filter(Boolean),  // ← extrait les URLs
            aspectRatio:    form.aspectRatio || form.ratio || "1:1",
            resolution:     form.quality || form.resolution || "1k",
            negativePrompt: form.negativePrompt,
            outputFormat:   "png",
        };
    }

    toPayload({ prompt, images, aspectRatio, resolution, negativePrompt, outputFormat }) {
        return {
            prompt,
            images,                                          // ← tableau d'images pour l'API
            aspect_ratio:    aspectRatio || "1:1",
            resolution:      String(resolution || "1k").toLowerCase(),
            negative_prompt: negativePrompt || "",
            output_format:   outputFormat || "png",
        };
    }
}
```

---

## 6. Couche 5: Treatment — Le workflow métier complet

### 6.1 BaseGenerateImageTreatment (flow complet)

**Fichier**: `src/image/treatments/basetretment/BaseGenerateImageTreatment.js`

```
Controller (HTTP)                    Worker (BullMQ)
      │                                    │
      ▼                                    ▼
┌──────────────┐                  ┌──────────────────┐
│  prepare()   │  ──enqueue──▶   │   optimizePrompt │
│  (sync)      │    task         │   (async)        │
│              │                  │                  │
│ 1. resolveProvider()           │ 1. Safety check  │
│ 2. check wallet balance          │ 2. Enhance prompt│
│ 3. calculateImageCredits()       │ 3. Negative prompt│
│ 4. hold()                      │                  │
│ 5. create DB records           │                  │
│ 6. enqueueTreatmentJob()       │                  │
│ 7. return { jobId, balance }  │                  │
└──────────────┘                  └────────┬─────────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │   run()      │
                                    │              │
                                    │ 1. _resolveProvider()
                                    │ 2. buildPayload()
                                    │ 3. provider.generate()
                                    │ 4. upload to storage
                                    │ 5. update DB
                                    │ 6. commit() or rollback()
                                    └──────────────┘
```

### 6.2 Code: Phase prepare()

```javascript
async _runPrepare({ prompt, model_name, ratio, quality, count = 1, userId, project_id, input_assets = [] }) {

    // 1. Fast-fail: vérifier que le modèle existe
    this._resolveProvider(model_name, input_assets);  // throw si invalide

    // 2. Vérifier le solde wallet
    let holdAmount = 0;
    let pricingDetails = null;
    if (this.walletService && userId) {
        pricingDetails = calculateImageCredits({
            modelKey: model_name || "z_image",
            quality: verified.quality || "standard",
            count: verified.count,
            operation: "generated",
        });
        holdAmount = pricingDetails.credits;
        await this.walletService.checkSufficientFunds(userId, holdAmount);
    }

    // 3. Créer les records DB (config, workflows, media placeholders)
    const config = await this.db.configs.createConfig({ prompt, model: model_name, ... });
    const workflows = await this.db.workflows.createWorkflow({ ... });
    const media = await appendMediaToWorkflow(this.db, { ... });

    // 4. Retourner le task descriptor (sérialisable pour Redis)
    return {
        userId, project_id, model_name, prompt,
        walletHoldAmount: holdAmount,
        pricingDetails,
        configId: config.id,
        workflows, mediaIds,
        // ...
    };
}
```

### 6.3 Code: Phase execute() (hold + enqueue)

```javascript
async execute(input) {
    const task = await this.prepare(input);
    const userId = input?.userId || input?.user_id;

    // HOLD: bloquer les crédits
    if (this.walletService && userId && task.walletHoldAmount > 0) {
        const walletReferenceId = task.configId;  // reference unique = configId

        await this.walletService.hold({
            userId,
            amount: task.walletHoldAmount,
            referenceId: walletReferenceId,
            metadata: {
                treatment: this.getQueueType(),
                model_name: task.model_name,
                prompt: task.prompt,
                count: task.count,
                pricingVersion: task.pricingDetails?.pricingVersion,
                pricingBreakdown: task.pricingDetails?.breakdown,
            },
        });

        task.walletReferenceId = walletReferenceId;
        const wallet = await this.walletService.getWalletOrThrow(userId);
        task.remainingBalance = wallet.balance;  // ← retourné au frontend
    }

    // Enqueue dans BullMQ
    const job = await enqueueTreatmentJob(this.getQueueType(), task, {});

    return {
        jobId: job.id,
        status: "queued",
        balance: task.remainingBalance ?? null,
    };
}
```

### 6.4 Code: Phase run() (worker)

```javascript
async _runVariation({ provider, workflow, mediaId, userId, model_name, finalPrompt, finalNegative, ratio, quality, ... }) {

    // 1. Déterminer les assets source
    const sourceAsset = input_assets?.find(a => ["source", "normal", "start", "base"].includes(a.role))
        ?? input_assets?.[0];

    // 2. Construire le formulaire
    const form = {
        prompt: finalPrompt,
        negativePrompt: finalNegative,
        ratio, quality,
        image: sourceAsset?.url ?? null,   // ← pour i2i
        references: input_assets,
    };

    // 3. Build payload → call provider → extract URL
    const payload = this._buildPayload(provider, form);
    const result = await provider.generate(payload);
    const outputUrl = extractOutputUrl(result);  // image_url, url, output.url...

    // 4. Upload vers Supabase Storage
    const fileName = `${userId}/generations/${workflow.id}_${Date.now()}.png`;
    const fileUrl = await this.storageService.uploadFromUrl(fileName, outputUrl);

    // 5. Update DB
    await this.db.media.updateFields(mediaId, { url: fileUrl, width, height });
    await markMediaStatus(this.db, mediaId, "success");

    return { fileUrl, mediaId, workflowId: workflow.id };
}
```

### 6.5 Code: Phase runJob() (worker + wallet)

```javascript
async runJob(task) {
    try {
        // Si déjà fait (replay) → skip
        const duplicateSkip = await skipIfAllMediaAlreadyDone(this.db, task.mediaIds);
        if (duplicateSkip) {
            await this.walletService.commitHoldIdempotent(task.walletReferenceId);
            return duplicateSkip;
        }

        // Pipeline: optimize → generate → upload
        const optimized = await this.optimizePrompt(task);
        const result = await this.run(task, optimized);

        // SUCCESS → commit les crédits
        await this.walletService.commitHoldIdempotent(task.walletReferenceId);
        return result;

    } catch (error) {
        // FAILED → rollback (refund)
        if (this.walletService && task.walletReferenceId) {
            try {
                await this.walletService.rollback(task.walletReferenceId);
            } catch (walletError) {
                // Persist pour retry automatique
                await failedOpsService.record({
                    operationType: "ROLLBACK",
                    referenceId: task.walletReferenceId,
                    userId: task.userId,
                    failureReason: walletError.message,
                });
            }
        }
        throw error;
    }
}
```

---

## 7. Système de crédits (Pricing)

### 7.1 Deux niveaux de pricing

| Niveau | Description | Exemple |
|--------|-------------|---------|
| **Prix réel** (USD) | Ce que le provider facture | `$0.05` par image nanobana |
| **Crédits** (virtuel) | Ce que l'utilisateur paie | `8` crédits pour nanobana standard |

Le mapping USD → Crédits est **arbitraire** et défini dans `modelRouter.js`. Ce n'est pas un taux de change fixe.

### 7.2 Pricing exact (table) vs Formule

```
┌────────────────────────────────────────────────────────────┐
│  PRICING EXACT (table) — prioritaire                       │
│  Défini manuellement par modèle/quality/opération          │
│                                                             │
│  nanobana + generated + standard = 8                         │
│  nanobana + generated + hd     = 11                        │
│  nanobana + edit      + standard = 9                        │
│  kling_v3 + 720p + 5s = 42                                   │
│  kling_v3 + 1080p + 5s = 60                                  │
└────────────────────────────────────────────────────────────┘
                           │ si pas de table
                           ▼
┌────────────────────────────────────────────────────────────┐
│  PRICING FORMULE (fallback)                                │
│                                                             │
│  Image: baseCredits × qualityMultiplier × count           │
│  Ex: 10 × 1.5 (2k) × 2 = 30 crédits                        │
│                                                             │
│  Video: (base + perSecond × duration) × resolution × count │
│  Ex: (20 + 4 × 5) × 1.6 (1080p) × 1 = 64 crédits           │
└────────────────────────────────────────────────────────────┘
```

### 7.3 Comment le prix est utilisé dans le flow

```
User sélectionne "nanobana" + "hd" + count=2
       │
       ▼
controller → treatment._runPrepare()
       │
       ▼
calculateImageCredits({ modelKey: "nanobana", quality: "hd", count: 2, operation: "generated" })
       │
       ▼
Pricing exact: table["generated"]["hd"] = 11
       │
       ▼
credits = 11 × 2 = 22 crédits
       │
       ▼
walletService.checkSufficientFunds(userId, 22)  →  OK si balance ≥ 22
       │
       ▼
walletService.hold({ amount: 22, referenceId: configId })
       │
       ▼
Return { jobId, status: "queued", balance: balance - 22 }
```

---

## 8. Provider Registry Global (Feature 008)

### 8.1 Adapter Pattern

**Fichier**: `src/providers/providerAdapterContract.js`

Le feature 008 introduit un **Provider Adapter** qui wrappe les treatments existants dans une interface standardisée.

```javascript
export function createStaticProviderAdapter({
    providerId,           // ex: "image-runners"
    capabilities,           // ex: ["image-generation", "image-editing"]
    healthy = true,
    cost = 1,             // crédits estimés
    latencyMs = 1000,     // latence estimée
    qualityTier = "standard",
    execute = async () => ({ outputs: [] }),
}) {
    return validateProviderAdapter({
        providerId,
        qualityTier,
        supportedCapabilities: () => capabilities,
        isHealthy: async () => ({ healthy: Boolean(healthy) }),
        estimateCost: async () => ({ amount: cost, unit: "credits" }),
        estimateLatency: async () => ({ p50Ms: latencyMs, p95Ms: latencyMs }),
        execute,
    });
}
```

### 8.2 Image Runner Adapter

**Fichier**: `src/providers/adapters/imageRunnerProviderAdapter.js`

```javascript
export function createImageRunnerProviderAdapter({
    providerId,
    runner = null,         // ← ImageTreatmentV2 instance
    cost = 10,
    latencyMs = 1200,
    qualityTier = "standard",
}) {
    return createStaticProviderAdapter({
        providerId,
        capabilities: [MEDIA_CAPABILITIES.IMAGE_GENERATION, MEDIA_CAPABILITIES.IMAGE_EDITING],
        cost, latencyMs, qualityTier,
        execute: async (request) => {
            // Delegue au treatment existant
            if (runner && typeof runner.execute === "function") {
                return runner.execute(request);
            }
            if (runner && typeof runner.run === "function") {
                return runner.run(request);
            }
            return { outputs: [], status: "adapter-ready" };
        },
    });
}
```

### 8.3 Registration dans le container

**Fichier**: `src/container.js`

```javascript
import { registerProviders } from "./providers/providerRegistry.js";
import { createImageRunnerProviderAdapter } from "./providers/adapters/imageRunnerProviderAdapter.js";
import { createVideoRunnerProviderAdapter } from "./providers/adapters/videoRunnerProviderAdapter.js";

registerProviders([
    createImageRunnerProviderAdapter({
        providerId: "image-runners",
        runner: imageTreatmentV2,
        cost: 10,
        latencyMs: 1200,
        qualityTier: "standard",
    }),
    createVideoRunnerProviderAdapter({
        providerId: "video-runners",
        runner: videoTreatment,
        cost: 20,
        latencyMs: 5000,
        qualityTier: "standard",
    }),
]);
```

---

## 9. Diagramme de flux complet

### 9.1 Flow Image Génération (Text-to-Image)

```
┌──────────────┐
│   FRONTEND   │
│ User clique  │
│ "Generate"   │
└──────┬───────┘
       │ POST /api/images/generate
       │ { model: "nanobana", prompt: "cat", quality: "hd", count: 2 }
       ▼
┌─────────────────────────────────────────────────────────────┐
│  CONTROLLER (Express)                                       │
│  imagesController.js → appelle treatment.execute(input)     │
└──────────────────────┬──────────────────────────────────────┘
                       │
       ┌───────────────┴───────────────┐
       ▼                               ▼
┌────────────────────┐      ┌────────────────────┐
│  Phase 1: PREPARE  │      │  Phase 2: HOLD     │
│  (sync, < 2s)      │      │  (sync, < 500ms)   │
│                    │      │                    │
│ 1. resolveProvider │      │ 1. calculateCredits│
│    → nanobana.t2i  │      │    → 11 × 2 = 22   │
│ 2. verifyParams    │      │ 2. check balance   │
│ 3. create DB       │      │ 3. hold(22)        │
│    config, workflow│      │ 4. balance -= 22   │
│    media placeholder │     │                    │
│ 4. return task     │      │ 5. return jobId    │
│    descriptor       │      │    + new balance   │
└─────────┬──────────┘      └────────────────────┘
          │
          │ Enqueue BullMQ
          ▼
┌─────────────────────────────────────────────────────────────┐
│  WORKER (BullMQ) — Phase 3: RUN                            │
│  worker.js reçoit le task et appelle treatment.runJob()     │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                        ▼
┌─────────────────┐      ┌─────────────────┐
│ optimizePrompt  │      │ _runVariation  │
│                 │      │ (pour chaque    │
│ 1. Safety check │      │  workflow)      │
│ 2. Enhance      │      │                 │
│ 3. Neg prompt   │      │ 1. buildPayload │
│                 │      │ 2. provider     │
│ return {final,  │      │    .generate()  │
│         finalNeg}│     │ 3. upload URL   │
└────────┬────────┘      │ 4. update DB    │
         │               └─────────────────┘
         │
         │ success
         ▼
┌─────────────────┐
│ wallet.commit() │
│ PENDING→COMPLETED│
│ (crédits déjà   │
│  déduits,       │
│  confirmation)  │
└─────────────────┘
         │
         │ Socket.IO emit
         ▼
┌──────────────┐
│  FRONTEND    │
│ reçoit image │
│ + balance    │
└──────────────┘
```

### 9.2 Flow Image Edit (Image-to-Image avec références)

```
User upload 2 images + prompt
       │
       ▼
Controller reçoit input_assets = [
    { url: "https://.../img1.png", role: "source" },
    { url: "https://.../img2.png", role: "reference" }
]
       │
       ▼
resolveProvider("nanobana", input_assets)
       │
       ├── hasRefs = true (2 refs)
       ├── isMulti = true (refs > 1)
       └── variantKey = "i2iMulti"  ← multi-references
       │
       ▼
provider = nanobana.i2iMulti  (ou nanobana.i2i si i2iMulti absent)
       │
       ▼
provider.adapt(form) → { prompt, images: [url1, url2], aspectRatio, resolution }
       │
       ▼
provider.toPayload(adapted) → { prompt, images, aspect_ratio, resolution, ... }
       │
       ▼
provider.generate(payload) → HTTP POST wavespeed API
       │
       ▼
return { image_url: "https://.../output.png" }
```

### 9.3 Flow Video Génération (Text-to-Video)

```
User sélectionne "kling_v3" + 5s + 1080p
       │
       ▼
VideoTreatment.prepare(input)
       │
       ├── calculateVideoCredits({ modelKey: "kling_v3", durationSeconds: 5, resolution: "1080p" })
       │   └── table["1080p"][5] = 60 crédits
       │
       ├── resolve mode: t2v (pas de start image)
       │
       ├── getRunner("kling_v3", "t2v") → kling_v3.t2v runner
       │
       ├── build form: { prompt, ratio, duration, cfgScale, resolution }
       │
       └── hold(60 crédits)
       │
       ▼
Worker.run(task)
       │
       ├── provider = validateProvider(model, mode) → kling_v3.t2v
       │
       ├── payload = provider.toPayload(provider.adapt(form), mode)
       │
       ├── provider.generate(payload) → HTTP POST → polling → outputUrl
       │
       ├── upload to storage
       │
       └── update DB
       │
       ▼
commit(60 crédits)
```

---

## 10. Points forts et faiblesses

### ✅ Points forts

| Aspect | Description |
|--------|-------------|
| **Registry pattern** | Chaque provider a son registry → ajouter un nouveau modèle = 1 fichier + 1 entrée dans router |
| **Double pricing** | Table exacte (prioritaire) + formule fallback → flexibilité totale |
| **Separation adapt/toPayload** | `adapt()` transforme UI → interne, `toPayload()` transforme interne → API → testable indépendamment |
| **Variant auto-resolution** | Le system choisit t2i/i2i/i2iMulti automatiquement selon les refs → user ne pense pas en "modes" |
| **Provider abstraction** | Feature 008 wrappe les treatments dans des adapters → future-proof pour agent orchestration |
| **Idempotent wallet** | commit/rollback idempotent → safe si BullMQ replay |
| **Fallbacks** | RPC PostgreSQL + fallback JS avec optimistic locking → robustesse |

### ⚠️ Points à améliorer

| Problème | Impact | Solution suggérée |
|----------|--------|-------------------|
| **Pricing hardcoded** | Changer un prix → déploiement + redémarrage | Migrer vers `pricing_rules` DB table (Feature 009) |
| **Pas de health check** | Provider down → erreurs 500 jusqu'à ce qu'un admin remarque | Ajouter health check périodique avec auto-failover |
| **Pas de retry côté provider** | Wavespeed timeout → génération perdue | Ajouter retry avec backoff dans le runner |
| **Pas de cost tracking réel** | Prix USD réel vs crédits → pas de marge calculée | Ajouter cost tracking par génération (comparer $ réel dépensé vs crédits gagnés) |
| **Models fermés restent en mémoire** | `closed: true` mais le runner est instancié | Lazy-load les runners ou les mettre en cache |
| **Pas de circuit breaker** | Provider lente → toutes les générations ralentissent | Ajouter circuit breaker (ex: 5 erreurs → fallback vers autre provider) |
| **Polling bloquant** | `_poll()` bloque le worker pendant 30-60s | Rendre le polling interruptible ou utiliser webhooks |

### 🎯 Architecture verdict

Le système provider d'OpenArt est **bien conçu** avec une séparation claire Registry → Router → Runner. Le principal point faible est le **pricing hardcoded** qui est déjà adressé dans le Feature 009 (Wallet Production Hardening) avec la table `pricing_rules`. Le deuxième point faible est l'absence de **health monitoring et failover automatique** entre providers.

Pour un PFE, cette architecture est **plus que suffisante**. Les améliorations suggérées (circuit breaker, health checks, cost tracking) sont des optimisations de production qui peuvent être ajoutées après la soutenance.

---

*Document généré pour l'analyse du projet OpenArt (PFE Licence Informatique)*
