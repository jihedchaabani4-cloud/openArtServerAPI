# Model System Deep Analysis

Date: 2026-08-20
Status: analysis / architecture planning

## 1. Goal

This document explains how models are currently organized in the backend, how they are called, how providers are selected, how cost is calculated, and why the system feels scattered.

It also proposes the target architecture for a cleaner professional model system that can work with the new UseCase runtime and upfront billing reserve plan.

## 2. Short Summary

The project currently has several model-related systems living together:

```txt
1. Image model router
2. Video model router
3. Per-provider runner registries
4. V2 provider adapters
5. Generic provider registry/resolver
6. DB-backed PricingService
7. Router-based pricing calculators
8. Legacy pricingUtils / APP_PRICING
9. Controller-level model defaults
10. Model metadata helpers for UI
```

This is why the model system feels scattered.

The good news: the project already has strong pieces. The main missing thing is one canonical "Model Catalog" layer that becomes the source of truth for:

- model identity
- domain: image/video/audio/etc.
- provider
- modes
- capabilities
- hidden/open state
- pricing keys
- runtime runner
- frontend metadata
- validation

## 3. Current Model Architecture

Current high-level flow:

```txt
Controller / UseCase Input
  -> model/model_name from request
  -> workflow node input
  -> V2 node
  -> V2 provider adapter
  -> image/video modelRouter
  -> runner registry
  -> concrete provider runner
  -> provider API
```

There are two main model domains:

```txt
Image models:
  apiOpenArt/src/image/core/modelRouter.js

Video models:
  apiOpenArt/src/video/core/modelRouter.js
```

Each domain has provider registries:

```txt
Image:
  src/image/runners/wavespeed/registry.js
  src/image/runners/fal/registry.js
  src/image/runners/replicate/registry.js
  src/image/runners/google/registry.js

Video:
  src/video/runners/wavespeed/registry.js
  src/video/runners/replicate/registry.js
  src/video/runners/google/registry.js
```

Each provider registry exports model groups/runners. The router imports all registries and exposes public model keys.

## 4. Key Files and Their Roles

### 4.1 Image model router

File:

```txt
apiOpenArt/src/image/core/modelRouter.js
```

Responsibilities:

- imports all image provider registries
- builds `IMAGE_ROUTES`
- maps public keys like `nanobana`, `gpt-image-2`, `seedream-pro`
- stores image pricing tables
- stores open/hidden flags
- stores capabilities like `supportsEdit` and `supportsCamera`
- resolves runners:
  - `getImageRunner(modelKey, variant)`
  - `getImageModel(modelKey)`
  - `getUpscaleModel(modelKey)`
- calculates image credits:
  - `calculateImageCredits`
  - `calculateUpscaleCredits`

Current public model route shape:

```js
{
  t2i,
  i2i,
  i2iMulti,
  group,
  type,
  open,
  hidden,
  supportsEdit,
  supportsCamera,
  pricing
}
```

### 4.2 Video model router

File:

```txt
apiOpenArt/src/video/core/modelRouter.js
```

Responsibilities:

- imports all video provider registries
- builds `MODEL_ROUTES`
- maps public keys like `kling_v3`, `runway_gen4_turbo`, `seedance_v15_pro`
- stores video pricing tables
- stores open/hidden flags
- stores `supportsEdit` and `supportsCamera`
- resolves video runners:
  - `getRunner(modelKey, mode)`
  - `getUpscaleRunner(modelKey)`
- calculates video credits:
  - `calculateVideoCredits`

Current public model route shape:

```js
{
  t2v,
  i2v,
  i2v_se,
  motion,
  r2v,
  v2v,
  upscale,
  _default,
  group,
  info,
  type,
  open,
  hidden,
  supportsEdit,
  supportsCamera,
  pricing
}
```

### 4.3 BaseModel

File:

```txt
apiOpenArt/src/core/BaseModel.js
```

Responsibilities:

- base class for model runner instances
- stores:
  - provider
  - type
  - modelName
  - displayName
  - capabilities
  - supported ratios
  - duration limits
  - pricing metadata
  - hidden flag
- requires models to implement:
  - `adapt`
  - `toPayload`
  - `generate`

### 4.4 ModelGroup

File:

```txt
apiOpenArt/src/core/ModelGroup.js
```

Responsibilities:

- groups image variants:
  - `t2i`
  - `i2i`
  - `i2iMulti`
- auto-selects a variant based on references
- provides metadata for model listing

### 4.5 V2 image adapter

File:

```txt
apiOpenArt/src/v2/providers/adapters/imageAdapter.js
```

Responsibilities:

- receives V2 image generation request
- reads `request.model` / `request.model_name`
- calls legacy/provider strategy to resolve model runner
- builds provider payload
- calls `runner.generate(payload)`
- normalizes output to V2 assets

Important observation:

```txt
The V2 provider adapter uses the old image runner system directly.
```

This is acceptable as a bridge, but it means model routing is not purely V2 yet.

### 4.6 V2 video adapter

File:

```txt
apiOpenArt/src/v2/providers/adapters/videoAdapter.js
```

Responsibilities:

- receives V2 video generation request
- reads `request.model` / `request.model_name`
- reads `request.mode`
- calls `getRunner(modelName, mode)`
- adapts payload through runner
- calls `runner.generate(payload)`
- normalizes output to V2 video asset

### 4.7 Generic provider resolver

Files:

```txt
apiOpenArt/src/providers/providerRegistry.js
apiOpenArt/src/providers/providerResolver.js
apiOpenArt/src/v2/providers/router.js
```

Responsibilities:

- registers providers like `fal`, `runway`, `topaz`
- selects provider by capability, cost, latency, quality
- allows forced provider override

Important observation:

```txt
The generic provider resolver selects a provider adapter.
Then the adapter selects the actual model runner.
```

This creates two routing layers:

```txt
Provider routing:
  image capability -> fal adapter

Model routing:
  model = gpt-image-2 -> wavespeed/google runner
```

This can be confusing because the selected provider id may not match the real model provider.

Example:

```txt
V2 selects providerId = "fal"
imageAdapter receives model = "gpt-image-2"
imageAdapter can route to wavespeed runner
metadata may say provider = fal, model runner = wavespeed model
```

This needs cleanup.

### 4.8 Model validation helpers

File:

```txt
apiOpenArt/lib/modelRegistryKeys.js
```

Responsibilities:

- normalizes some aliases
- checks whether an image/video model exists
- hides hidden/closed models

Current alias map is very small:

```js
{
  nanobana_normal: "nanobana"
}
```

Problem:

Many IDs in frontend/config/docs may use different naming styles:

```txt
z-image-pro
z_image
kling-3-pro
kling_v3_pro
gpt-image-2
gpt_image_2_wavespeed
```

Alias normalization is not centralized enough.

### 4.9 Model metadata helpers

File:

```txt
apiOpenArt/src/utils/modelUtils.js
```

Responsibilities:

- returns icon/label based on model name string
- exports `MODEL_FAMILIES`

Problem:

`MODEL_FAMILIES` contains model IDs that do not necessarily match current router keys. This can become stale UI metadata.

### 4.10 Project model config response

File:

```txt
apiOpenArt/controllers/projectController.js
```

Responsibilities:

- builds `modelConfig` for frontend from `MODEL_ROUTES` and `IMAGE_ROUTES`
- sends:
  - model list
  - model pricing from routes
  - app pricing from `APP_PRICING`

Problem:

The frontend receives route-based pricing, not necessarily DB `PricingService` pricing.

## 5. Current Pricing Architecture

There are multiple pricing systems.

### 5.1 Router-based pricing

Files:

```txt
apiOpenArt/src/image/core/modelRouter.js
apiOpenArt/src/video/core/modelRouter.js
apiOpenArt/lib/pricingUtils.js
apiOpenArt/src/config/pricing.js
```

Behavior:

- each route has pricing config
- image credits calculated by `calculateImageCredits`
- video credits calculated by `calculateVideoCredits`
- `pricingUtils.calculateCredits` auto-detects image/video
- `APP_PRICING` calculates app-level default prices from router pricing

Pros:

- simple
- fast
- code-local
- easy to see model pricing near model config

Cons:

- requires code deploy to change prices
- can diverge from DB pricing
- not admin-managed
- not ideal for billing source of truth

### 5.2 DB-backed PricingService

Files:

```txt
apiOpenArt/src/platform/billing/PricingService.js
apiOpenArt/migrations/003_pricing_rules.sql
apiOpenArt/controllers/walletController.js
```

Behavior:

- reads `pricing_rules` table
- caches in Redis
- returns `creditCost`
- wallet API exposes `/api/wallet/price`

Pros:

- admin-managed
- no deploy needed for price changes
- cacheable
- designed as source of truth

Cons:

- current migration seed uses old/inconsistent model keys:
  - `gpt-image-1`
  - `kling-v1`
  - `kling-v2`
  - `fal-upscale`
- router keys use:
  - `gpt-image-2`
  - `kling_v3`
  - `topaz_image_upscale`
- operation names differ from V2 node types:
  - DB: `IMAGE_GENERATION`, `VIDEO_GENERATION`, `IMAGE_EDIT`, `UPSCALE`
  - V2 nodes: `image-generation`, `video-generation`, `media-transform`, `upscale`
- quality tiers differ:
  - DB: `standard`, `hd`, `4k`
  - image router: `standard`, `hd`, `1k`, `2k`, `4k`
  - video router: resolution `720p`, `1080p`

### 5.3 V2 BudgetEstimator

File:

```txt
apiOpenArt/src/v2/billing/BudgetEstimator.js
```

Behavior:

- estimates provider-backed node cost
- resolves model/quality from node inputs
- calls:

```js
pricingService.getPrice(model, node.type, quality)
```

Problem:

This passes node type as operation:

```txt
image-generation
video-generation
upscale
```

But DB expects:

```txt
IMAGE_GENERATION
VIDEO_GENERATION
UPSCALE
```

This can cause pricing misses unless pricing rules duplicate V2 node type strings.

### 5.4 Legacy treatment billing

File:

```txt
apiOpenArt/src/image/treatments/basetretment/BaseEditTreatment.js
```

Behavior:

- calculates image credits using router pricing
- checks wallet balance directly
- later handles wallet rollback/settle in treatment flow

Problem:

This is another billing path separate from V2 UseCase billing.

### 5.5 Payments model comparison pricing

File:

```txt
apiOpenArt/controllers/payments/paymentsUtils.js
```

Behavior:

- calculates package/media count using router pricing

Problem:

If actual billing uses DB pricing, payment comparison can show a different cost.

## 6. How Models Are Called Today

### 6.1 Image generation V2 flow

```txt
Controller
  -> UseCase input has model/model_name
  -> workflow YAML binds model into generate node
  -> imageGenerationNode
  -> selectProvider(IMAGE_GENERATION)
  -> imageAdapter
  -> resolve model runner
  -> runner.generate
```

Inside image node:

```txt
safe.model comes from input.model
provider adapter receives model
adapter routes to image runner
```

### 6.2 Video generation V2 flow

```txt
Controller
  -> UseCase input has model/model_name
  -> workflow YAML binds model into video node
  -> videoGenerationNode
  -> selectProvider(VIDEO_GENERATION)
  -> videoAdapter
  -> getRunner(model, mode)
  -> runner.generate
```

### 6.3 Model list frontend flow

```txt
GET project data
  -> projectController.getModelConfig()
  -> read IMAGE_ROUTES + MODEL_ROUTES
  -> return models + route pricing
```

### 6.4 Wallet price flow

```txt
GET /api/wallet/price
  -> PricingService.getPrice(modelKey, operationType, qualityTier)
  -> pricing_rules DB
```

This can disagree with the project model config pricing.

## 7. Main Problems

### Problem 1: No single source of truth for model identity

Currently model identity exists in:

```txt
image router keys
video router keys
provider registry keys
BaseModel.modelName provider slugs
MODEL_FAMILIES IDs
PricingService DB keys
controller defaults
workflow YAML defaults
frontend model names
```

This creates bugs like:

```txt
Controller sends gpt-image-2
DB pricing has gpt-image-1
router pricing has gpt-image-2
provider runner uses gpt_image_2_wavespeed
provider API modelName is something else
```

### Problem 2: Public model key and provider model slug are mixed

There should be a strict difference:

```txt
publicModelKey:
  gpt-image-2
  kling_v3

providerModelSlug:
  wavespeed/openai/gpt-image-2
  kwaivgi/kling-v3.0-pro/text-to-video
```

Current code often calls both `model`, `model_name`, `modelKey`, or `modelName`, which makes meaning unclear.

### Problem 3: Two pricing sources

Router pricing and DB pricing both exist.

This causes possible mismatch between:

- frontend displayed price
- wallet price endpoint
- actual billing precheck
- package comparison page
- V2 usecase billing
- legacy treatment billing

### Problem 4: Operation naming mismatch

Different names for the same thing:

```txt
Router image operation:
  generated
  edit

DB operation:
  IMAGE_GENERATION
  IMAGE_EDIT

V2 node type:
  image-generation
  media-transform

UseCase naming:
  image-generation-v1
  image-edit-v1
```

Need one canonical operation enum.

### Problem 5: Quality/resolution mismatch

Image quality:

```txt
standard, hd, 1k, 2k, 4k
```

Video resolution:

```txt
720p, 1080p
```

DB quality tier:

```txt
standard, hd, 4k
```

This makes model-based billing difficult.

### Problem 6: Provider abstraction is misleading

V2 provider registry registers:

```txt
fal for image
runway for video
topaz for upscale
```

But actual image/video model runner can be:

```txt
wavespeed
google
replicate
fal
```

So the selected provider id can be only an adapter label, not the real provider.

### Problem 7: Controller defaults are scattered

Examples:

- image controller accepts model/model_name and may pass null
- edit image defaults to `fal`
- lighting defaults to `seedream-pro`
- camera defaults to `fal` or another model
- config pricing has defaults like `gpt-image-2`

Default model selection should be centralized by usecase/model catalog.

### Problem 8: Legacy and V2 systems overlap

Legacy treatment code still:

- resolves model provider
- calculates credits
- checks wallet
- queues old jobs

V2 also:

- resolves model provider
- estimates credits
- queues usecase jobs

This overlap is risky until all active routes are migrated to one path.

## 8. Target Architecture: Model Catalog

Create one canonical model catalog service/module:

```txt
src/models/
  modelCatalog.js
  modelPricingMapper.js
  modelOperation.js
  modelAliasRegistry.js
  modelCapabilityResolver.js
```

The model catalog should be the single backend source for:

```txt
public key
domain
provider
provider slug
display metadata
capabilities
supported operations
supported modes
quality/resolution options
hidden/open state
runner resolver
pricing key mapping
```

Target model record:

```js
{
  key: "gpt-image-2",
  domain: "image",
  provider: "wavespeed",
  providerModelKey: "gpt_image_2_wavespeed",
  providerModelSlug: "openai/gpt-image-2",
  displayName: "GPT Image 2",
  category: "image",
  tier: "pro",
  open: true,
  hidden: false,
  operations: ["IMAGE_GENERATION", "IMAGE_EDIT"],
  modes: ["t2i", "i2i", "i2iMulti"],
  capabilities: {
    edit: true,
    camera: false,
    references: true,
    maxReferences: 4
  },
  qualityOptions: ["standard", "hd", "2k", "4k"],
  defaultQuality: "standard",
  pricingKey: "gpt-image-2",
  runnerRef: {
    domain: "image",
    routeKey: "gpt-image-2"
  }
}
```

For video:

```js
{
  key: "kling_v3",
  domain: "video",
  provider: "wavespeed",
  providerModelKey: "kling_v3_wavespeed",
  operations: ["VIDEO_GENERATION", "VIDEO_EDIT"],
  modes: ["t2v", "i2v", "motion"],
  resolutionOptions: ["720p", "1080p"],
  durationOptions: [3, 5, 10, 15],
  pricingKey: "kling_v3"
}
```

## 9. Target Pricing Architecture

One pricing source of truth should be selected.

Recommended:

```txt
DB PricingService is source of truth for actual billing.
Router pricing can remain as fallback/default seed data only.
```

Target flow:

```txt
ModelCatalog resolves model + operation + quantity.
PricingService gets unit price from DB.
BillingRuntime multiplies by quantity.
```

Example:

```js
{
  modelKey: "gpt-image-2",
  operation: "IMAGE_GENERATION",
  qualityTier: "2k",
  quantity: 2
}
```

Pricing result:

```js
{
  unitCredits: 18,
  quantity: 2,
  totalCredits: 36,
  source: "pricing_rules",
  pricingKey: "gpt-image-2"
}
```

If DB price is missing:

Development behavior:

```txt
fallback to router pricing + warn loudly
```

Production behavior:

```txt
fail with PRICING_NOT_FOUND
do not enqueue paid job
```

## 10. Canonical Operation Enum

Use one enum everywhere:

```txt
IMAGE_GENERATION
IMAGE_EDIT
IMAGE_UPSCALE
VIDEO_GENERATION
VIDEO_EDIT
VIDEO_UPSCALE
LLM_TEXT
LLM_JSON
PROMPT_BUILD
SAFETY_CHECK
```

Map old values:

```txt
image-generation node -> IMAGE_GENERATION
media-transform image_edit -> IMAGE_EDIT
upscale image model -> IMAGE_UPSCALE
video-generation t2v/i2v -> VIDEO_GENERATION
video-generation v2v -> VIDEO_EDIT
llm -> LLM_TEXT or SAFETY_CHECK depending usecase policy
```

UseCase billing policy should use canonical operation names.

## 11. Target Model Call Flow

### 11.1 Image generation

```txt
NodeRuntime
  -> ModelCatalog.resolve({ modelKey, operation: IMAGE_GENERATION })
  -> validate model supports operation
  -> BillingRuntime already reserved based on same catalog
  -> ImageAdapter executes with resolved runner
  -> result metadata stores:
       publicModelKey
       provider
       providerModelSlug
       runner
```

### 11.2 Video generation

```txt
NodeRuntime
  -> ModelCatalog.resolve({ modelKey, operation: VIDEO_GENERATION, mode })
  -> validate mode/duration/resolution
  -> VideoAdapter executes with resolved runner
```

### 11.3 Frontend model list

```txt
ProjectController
  -> ModelCatalog.listPublicModels()
  -> PricingService optional pricing summary
  -> return modelConfig
```

No controller should manually read `IMAGE_ROUTES` and `MODEL_ROUTES` long term.

## 12. How This Connects to UseCase Billing

From `docs/usecase-runtime-billing-architecture.md`, billing must reserve before queue.

For model-based nodes, cost calculation should use:

```txt
UseCase billing policy
  -> billable node list
  -> node input model field
  -> ModelCatalog validation
  -> PricingService price
  -> BillingRuntime reserve
```

Example usecase policy:

```js
{
  billing: {
    mode: "upfront-reserve",
    nodes: {
      llm_translate: { billable: false },
      generate: {
        billable: true,
        operation: "IMAGE_GENERATION",
        modelField: "model",
        qualityField: "quality",
        quantityField: "count"
      }
    }
  }
}
```

Cost calculation:

```txt
model = input.model || usecase default || model catalog default
operation = IMAGE_GENERATION
quality = input.quality || default
quantity = input.count || 1
unit price = PricingService.getPrice(model, operation, quality)
total = unit price * quantity
```

## 13. Concrete Current Risks

### Risk 1: Wrong cost shown vs charged

Frontend can receive route-based pricing from `projectController`, but billing can use `PricingService`.

Result:

```txt
UI says 12 credits.
Billing tries DB price and gets 20 credits or not found.
```

### Risk 2: Missing pricing rule blocks usecase

`BudgetEstimator` calls:

```txt
getPrice(model, node.type, quality)
```

If DB expects `IMAGE_GENERATION`, this fails for `image-generation`.

### Risk 3: Provider metadata is inaccurate

V2 provider selection can say `fal`, while actual runner can be wavespeed/google depending model.

### Risk 4: Model aliases are incomplete

Frontend/client can send a known display ID that backend does not normalize.

### Risk 5: Hidden models can leak through stale metadata

`MODEL_FAMILIES` has hardcoded IDs separate from route hidden/open state.

### Risk 6: Legacy route can bypass new UseCase billing

Any path still using legacy treatment billing can behave differently from V2 upfront reserve.

## 14. Recommended Refactor Plan

### Phase 1: Document and freeze names

Create a canonical table:

```txt
public_model_key | domain | provider | provider_registry_key | operations | pricing_key | open | hidden
```

This can start as generated documentation from existing routers.

### Phase 2: Add ModelCatalog facade

Create:

```txt
apiOpenArt/src/models/modelCatalog.js
```

Initial implementation can wrap existing routers:

```js
listModels()
getModel(modelKey)
normalizeModelKey(input)
resolveRunner({ modelKey, operation, mode })
validateModelSupports({ modelKey, operation, mode })
getPricingLookup({ modelKey, operation, quality })
```

This avoids rewriting all routers immediately.

### Phase 3: Add canonical operation mapper

Create:

```txt
apiOpenArt/src/models/modelOperations.js
```

Map:

```txt
node type + mode -> operation enum
router operation -> operation enum
DB operation -> operation enum
```

### Phase 4: Unify pricing lookup

Create:

```txt
apiOpenArt/src/models/modelPricingService.js
```

Behavior:

```txt
1. Use PricingService DB in production.
2. Optionally fallback to router pricing in development.
3. Always return same shape:
   { unitCredits, quantity, totalCredits, source, breakdown }
```

### Phase 5: Update UseCase billing runtime

When calculating upfront reserve:

```txt
UseCase billing policy
  -> ModelCatalog
  -> ModelPricingService
  -> reserve total
```

Do not use old `BudgetEstimator` directly for final billing without mapping.

### Phase 6: Update frontend model config

Change `projectController.getModelConfig()` to use:

```txt
ModelCatalog.listPublicModels()
```

Optionally include display pricing from the same pricing source used for billing.

### Phase 7: Clean V2 provider selection

Recommended direction:

```txt
Model determines provider/runner.
Generic provider resolver becomes fallback/health layer, not primary model selector.
```

For V2 media nodes:

```txt
imageGenerationNode
  -> ModelCatalog.resolveRunner()
  -> execute runner
```

or:

```txt
imageAdapter receives resolved model execution plan, not raw model string.
```

### Phase 8: Deprecate legacy pricing utilities for billing

Keep router calculators only for:

- development fallback
- seed generation
- migration scripts

Do not use them for final billing if DB pricing is enabled.

## 15. Proposed ModelCatalog API

```js
modelCatalog.normalizeKey(inputKey)
modelCatalog.getModel(modelKey)
modelCatalog.listPublicModels({ domain })
modelCatalog.validateModel({ modelKey, operation, mode })
modelCatalog.resolveRunner({ modelKey, operation, mode, references })
modelCatalog.getDefaultModel({ useCaseId, operation })
modelCatalog.getPricingLookup({ modelKey, operation, quality, resolution })
```

Return shape for `getModel`:

```js
{
  key,
  domain,
  displayName,
  provider,
  providerRegistryKey,
  open,
  hidden,
  operations,
  modes,
  capabilities,
  pricingKey,
  route,
  runner
}
```

## 16. Proposed Pricing Return Shape

```js
{
  modelKey: "gpt-image-2",
  operation: "IMAGE_GENERATION",
  qualityTier: "2k",
  quantity: 2,
  unitCredits: 18,
  totalCredits: 36,
  source: "pricing_rules",
  breakdown: {
    provider: "wavespeed",
    domain: "image",
    mode: "t2i"
  }
}
```

## 17. What Should Be the Source of Truth?

Recommended final rule:

```txt
ModelCatalog is source of truth for model identity/capabilities/routing.
PricingService DB is source of truth for billable credit prices.
UseCase billing policy is source of truth for which nodes are billable.
```

This separates responsibilities:

```txt
ModelCatalog:
  What model is this and can it do the job?

PricingService:
  How much does this model/operation/quality cost?

UseCase billing policy:
  Should this node be charged in this usecase?

BillingRuntime:
  Reserve, settle, rollback.
```

## 18. First Practical Fixes

1. Add `ModelCatalog` wrapper over existing routers.
2. Add operation enum and mapper.
3. Stop passing raw node type to `PricingService.getPrice`.
4. Align pricing rule keys with actual router public model keys.
5. Update project model config to use catalog.
6. Make V2 billing use catalog + PricingService.
7. Keep router pricing only as fallback or seed generator.
8. Normalize model aliases in one place.
9. Store both public model key and provider model slug in output metadata.
10. Remove model defaults from random controllers and move them into usecase/model policy.

## 19. Bottom Line

The system is not bad; it is just split across old and new layers.

Current model architecture:

```txt
Routers know models.
Adapters call runners.
Controllers set defaults.
Pricing is partly in code and partly in DB.
Legacy treatments still calculate cost.
V2 billing estimates cost another way.
```

Target architecture:

```txt
ModelCatalog knows models.
PricingService knows prices.
UseCase billing policy knows what to charge.
BillingRuntime reserves before queue.
NodeRuntime executes safely.
Adapters only call providers.
Controllers stay thin.
```

This will make adding or changing models much safer:

```txt
Add model once in catalog/router.
Add pricing once in pricing_rules.
Expose it automatically to frontend.
Use it automatically in billing.
Execute it through one runtime path.
```

## 20. Implemented Model Service Slice - 2026-08-21

Status: first model service layer implemented.

The current implementation keeps the existing image/video routers as the execution bridge and adds one official facade above them:

```txt
Controller / UseCase Billing
  -> ModelService
    -> ModelCatalog
      -> existing image modelRouter
      -> existing video modelRouter
    -> ModelPricingService
      -> formula calculators
      -> router pricing fallback
```

Implemented files:

```txt
apiOpenArt/src/models/modelOperations.js
apiOpenArt/src/models/pricingFormulas.js
apiOpenArt/src/models/modelCatalog.js
apiOpenArt/src/models/modelPricingService.js
apiOpenArt/src/models/modelService.js
apiOpenArt/src/models/index.js
```

The model system now has these boundaries:

```txt
ModelCatalog:
  model identity
  domain image/video
  route lookup
  default provider metadata
  operation support
  hidden/open metadata

ModelPricingService:
  cost calculation
  quality tier handling
  video duration/resolution handling
  image quantity handling
  upscale scale handling
  router fallback pricing

ModelService:
  public API used by controllers/usecases
  validates operation/model combination
  resolves provider defaults
  returns pricing breakdown
```

Current cost inputs:

```txt
image generation:
  modelKey
  quality or resolution
  quantity/count
  provider optional

image edit:
  modelKey
  quality or resolution
  quantity/count
  source_url/sourceImage resolved by usecase input

video generation/edit:
  modelKey
  durationSeconds
  resolution
  mode
  provider optional

upscale:
  modelKey
  scale
  quantity/count
```

Provider payload adaptation is still owned by existing runners:

```txt
runner.adapt(form)
runner.toPayload(adapted)
runner.generate(payload)
```

This is intentional for the first slice. The new model layer does not try to rewrite provider APIs. It gives the rest of the backend one place to ask:

```txt
Is this model valid?
Which operation does it support?
Which provider is default?
How much should we reserve?
What pricing breakdown should be logged?
```

Implemented pricing smoke example:

```txt
image:
  gpt-image-2
  quality 2k
  count 2
  total 36 credits

video:
  kling_v3
  5 seconds
  720p
  total 42 credits
```

Next model-system improvements:

```txt
1. Move DB pricing_rules behind ModelPricingService as primary source.
2. Add provider-specific pricing overrides.
3. Add model aliases in ModelCatalog instead of controllers.
4. Add canonical provider request schemas per operation.
5. Move project model listing fully through ModelService.
6. Add admin/update workflow for model definitions and prices.
```
