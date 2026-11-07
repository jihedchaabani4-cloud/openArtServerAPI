# Backend Refactor Implementation Plan

Date: 2026-08-21
Status: planning document before code changes

Related analysis:

- `docs/full-backend-system-deep-analysis.md`
- `docs/model-system-deep-analysis.md`
- `docs/usecase-runtime-billing-architecture.md`

## 1. Goal

Build a professional backend runtime where product actions are implemented as UseCases, and the system centrally controls:

- model definitions
- provider selection
- provider-specific payload adaptation
- model cost calculation
- upfront credit reserve before queue
- worker execution
- node execution status
- error classification
- refund / settle
- final run status

The main rule:

```txt
No paid UseCase enters the worker queue before credits are reserved.
```

The second main rule:

```txt
Models, providers, and prices must be defined through one model service layer, not scattered across controllers, routers, pricing files, and workers.
```

## 2. Current Problems

### Problem 1: Model information is scattered

Today model information is spread across:

```txt
apiOpenArt/src/image/core/modelRouter.js
apiOpenArt/src/video/core/modelRouter.js
apiOpenArt/src/image/runners/*/registry.js
apiOpenArt/src/video/runners/*/registry.js
apiOpenArt/lib/modelRegistryKeys.js
apiOpenArt/src/utils/modelUtils.js
apiOpenArt/src/config/pricing.js
controllers with model defaults
pricing_rules DB table
```

This makes it hard to answer simple questions:

```txt
Is this model valid?
Is it image or video?
Which provider should run it by default?
Which fallback providers can run it?
Which operation does it support?
How much does it cost?
Which runner should execute it?
```

### Problem 2: Model and provider are not clearly separated

We need this distinction:

```txt
public model key:
  gpt-image-2

provider profile:
  wavespeed / fal / google

provider runner key:
  gpt_image_2_wavespeed

provider API slug:
  openai/gpt-image-2
```

Today these concepts are mixed across routers, runners, and controllers.

### Problem 3: One model can have multiple providers

The system must support:

```txt
model: gpt-image-2
providers:
  wavespeed default
  fal fallback
  google optional
```

Each provider can have different:

- payload format
- API slug
- capabilities
- latency
- cost profile
- quality
- failure behavior

### Problem 4: Provider inputs differ

This part is already partially solved by existing runners:

```txt
adapt(form)
toPayload(adapted)
generate(payload)
```

But the input to `adapt()` is not an official contract yet. Runners currently read inconsistent fields:

```txt
ratio / aspectRatio / aspect_ratio
quality / resolution
source_url / source_asset / image / image_base64
references / input_assets
duration / durationSeconds
```

We need official canonical request shapes.

### Problem 5: Pricing is scattered

Today pricing exists in multiple places:

```txt
image modelRouter pricing tables
video modelRouter pricing tables
src/config/pricing.js APP_PRICING
lib/pricingUtils.js
PricingService DB pricing_rules
BudgetEstimator fallback values
legacy treatment billing
```

This can make the UI show one price while billing reserves another price.

### Problem 6: Current pricing table is too simple

The current DB pricing table supports:

```txt
model_key + operation_type + quality_tier -> credit_cost
```

But real model pricing needs formulas:

```txt
image quality table
video duration + resolution table
video per second
upscale scale table
LLM fixed/token-based
count/quantity multiplier
optional provider-specific price
```

### Problem 7: Billing can happen too late

Current node execution can reserve credits inside the worker/node execution flow.

Risk:

```txt
User has 10 credits.
UseCase A costs 10.
UseCase B costs 10.
Both enter queue before reserve.
Workers can start expensive work before money is safely held.
```

Target:

```txt
UseCaseService calculates and reserves total billable cost before queue.
```

### Problem 8: Error and refund rules are scattered

Errors can happen in:

- input validation
- pricing lookup
- wallet reserve
- LLM safety
- provider call
- output validation
- persistence
- worker/orchestration

The system needs one policy to decide:

```txt
retry?
stop?
rollback?
settle?
mark media failed?
what frontend message?
```

## 3. Target Architecture

Final target:

```txt
Controller
  -> UseCaseService.prepareAndEnqueue
    -> UseCaseRegistry
    -> WorkflowCompiler
    -> ModelService
      -> ModelCatalog
      -> ModelPricingService
      -> ProviderProfiles
    -> BillingRuntime.reserve
    -> JobQueueService

Worker
  -> WorkflowOrchestrator
  -> NodeRuntime
    -> ModelExecutionService
      -> ModelService
      -> Runner.adapt()
      -> Runner.toPayload()
      -> Runner.generate()
    -> NodeEnvelope
  -> ErrorPolicy
  -> BillingRuntime.settle/rollback
```

## 4. New Core Services

### 4.1 ModelService

Single public API for model questions.

Responsibilities:

```txt
get model
list public models
validate model supports operation
resolve default provider
resolve fallback providers
resolve runner
calculate model cost
build model execution metadata
```

Proposed methods:

```js
modelService.getModel(modelKey)
modelService.listModels({ domain, includeHidden })
modelService.validateModel({ modelKey, operation, mode })
modelService.resolveProvider({ modelKey, operation, preferredProvider })
modelService.resolveRunner({ modelKey, providerId, operation, mode })
modelService.calculateCost({ modelKey, operation, input, providerId })
```

### 4.2 ModelCatalog

Defines model identity, capabilities, providers, defaults, and routing.

Example:

```js
{
  key: "gpt-image-2",
  domain: "image",
  displayName: "GPT Image 2",
  status: "active",
  operations: ["IMAGE_GENERATION", "IMAGE_EDIT"],
  defaults: {
    provider: "wavespeed",
    quality: "2k",
    aspectRatio: "1:1",
    count: 1
  },
  capabilities: {
    textToImage: true,
    imageEdit: true,
    multiReference: true,
    maxReferences: 5,
    supportedQualities: ["standard", "hd", "2k", "4k"],
    supportedRatios: ["1:1", "16:9", "9:16"]
  },
  providers: {
    wavespeed: {
      enabled: true,
      default: true,
      runnerKey: "gpt_image_2_wavespeed",
      providerSlug: "openai/gpt-image-2",
      priority: 1,
      supports: ["IMAGE_GENERATION", "IMAGE_EDIT"],
      modes: ["t2i", "i2i"]
    },
    fal: {
      enabled: true,
      default: false,
      runnerKey: "gpt_image_2_fal",
      providerSlug: "fal-ai/gpt-image-2",
      priority: 2,
      supports: ["IMAGE_GENERATION"],
      modes: ["t2i"]
    }
  }
}
```

Initial implementation should wrap existing `IMAGE_ROUTES` and `MODEL_ROUTES` instead of replacing them.

### 4.3 ModelOperations

One canonical operation enum:

```txt
IMAGE_GENERATION
IMAGE_EDIT
IMAGE_UPSCALE
VIDEO_GENERATION
VIDEO_EDIT
VIDEO_UPSCALE
LLM_TEXT
LLM_JSON
SAFETY_CHECK
PROMPT_BUILD
```

It maps old names:

```txt
image-generation -> IMAGE_GENERATION
video-generation -> VIDEO_GENERATION
upscale -> IMAGE_UPSCALE / VIDEO_UPSCALE
media-transform image_edit -> IMAGE_EDIT
generated -> IMAGE_GENERATION
edit -> IMAGE_EDIT
```

### 4.4 ModelPricingService

Calculates cost using pricing rules and formulas.

Responsibilities:

```txt
load pricing rule
apply formula
return cost breakdown
fail if production price missing
fallback to router pricing in development only if allowed
```

Return shape:

```js
{
  modelKey: "gpt-image-2",
  providerId: "wavespeed",
  operation: "IMAGE_GENERATION",
  pricingMode: "quality_table",
  unitCredits: 18,
  quantity: 2,
  totalCredits: 36,
  source: "pricing_rules",
  inputs: {
    quality: "2k",
    count: 2
  }
}
```

### 4.5 PricingFormulas

Formula types:

```txt
fixed
quality_table
duration_resolution_table
per_second
scale_table
token_based
```

Image quality table:

```js
{
  pricingMode: "quality_table",
  rule: {
    qualityPrices: {
      standard: 12,
      hd: 15,
      "2k": 18,
      "4k": 22
    },
    quantityField: "count"
  }
}
```

Video duration/resolution table:

```js
{
  pricingMode: "duration_resolution_table",
  rule: {
    table: {
      "720p": { "3": 25, "5": 42, "10": 84 },
      "1080p": { "3": 35, "5": 60, "10": 120 }
    }
  }
}
```

Video per-second:

```js
{
  pricingMode: "per_second",
  rule: {
    baseCredits: 5,
    creditsPerSecond: 8,
    resolutionMultipliers: {
      "720p": 1,
      "1080p": 1.5
    }
  }
}
```

Upscale:

```js
{
  pricingMode: "scale_table",
  rule: {
    scalePrices: {
      "2": 6,
      "4": 11,
      "6": 15
    }
  }
}
```

### 4.6 ModelExecutionService

Executes models through the selected provider profile.

Flow:

```txt
canonical request
  -> ModelService.resolveProvider
  -> ModelService.resolveRunner
  -> runner.adapt(canonicalRequest)
  -> runner.toPayload(adapted)
  -> runner.generate(payload)
  -> normalize provider result
```

This keeps existing runners and their provider-specific payload logic.

### 4.7 Canonical Requests

Image:

```js
{
  operation: "IMAGE_GENERATION",
  modelKey: "gpt-image-2",
  prompt: "",
  negativePrompt: "",
  aspectRatio: "1:1",
  width: 1024,
  height: 1024,
  quality: "2k",
  count: 1,
  seed: null,
  references: [],
  sourceImage: null,
  mask: null
}
```

Video:

```js
{
  operation: "VIDEO_GENERATION",
  modelKey: "kling_v3",
  mode: "t2v",
  prompt: "",
  aspectRatio: "16:9",
  durationSeconds: 5,
  resolution: "720p",
  fps: 24,
  references: [],
  startFrame: null,
  endFrame: null,
  cameraControl: null
}
```

## 5. Billing Architecture

### 5.1 UseCase billing policy

Each usecase defines billable nodes:

```js
billing: {
  mode: "upfront-reserve",
  refundOnFailure: true,
  nodes: {
    llm_translate: {
      billable: false
    },
    generate: {
      billable: true,
      operation: "IMAGE_GENERATION",
      modelField: "model",
      qualityField: "quality",
      quantityField: "count"
    }
  }
}
```

This allows:

```txt
LLM free + generate paid
LLM paid + generate paid
all free
only upscale paid
```

### 5.2 Upfront reserve

Before queue:

```txt
UseCaseService.prepareAndEnqueue
  -> compile workflow
  -> read billable nodes
  -> resolve model + operation
  -> calculate cost via ModelService
  -> total cost
  -> wallet hold
  -> create run with billing hold metadata
  -> enqueue job
```

### 5.3 Worker guard

Before provider execution:

```txt
if usecase is paid and no billing hold exists:
  fail run before provider call
```

### 5.4 Settlement

On success:

```txt
settle hold
billing_status = settled
```

On safety block or final failure:

```txt
rollback hold
billing_status = refunded
```

## 6. Error Architecture

Add `ErrorPolicy`.

Common codes:

```txt
INVALID_INPUT
INSUFFICIENT_CREDITS
PRICING_NOT_FOUND
CONTENT_SAFETY_VIOLATION
PROVIDER_TIMEOUT
PROVIDER_RATE_LIMIT
PROVIDER_FAILED
OUTPUT_INVALID
PERSISTENCE_FAILED
NODE_FAILED
ORCHESTRATION_DEADLOCK
```

Each error becomes:

```js
{
  code,
  retryable,
  workflowAction,
  billingAction,
  userMessage,
  internalMessage,
  severity
}
```

Examples:

```txt
CONTENT_SAFETY_VIOLATION -> stop + rollback
INVALID_INPUT -> stop + no queue/no charge
PROVIDER_TIMEOUT -> retry, then rollback on final failure
PROVIDER_FAILED -> rollback
SUCCESS -> settle
```

## 7. Node Runtime Architecture

Current `nodeExecutor` does too much.

Target:

```txt
nodeExecutor
  -> load run/node
  -> call NodeRuntime.execute()
```

`NodeRuntime` handles:

```txt
resolve inputs
validate inputs
security checks
build canonical request
execute model if provider-backed
normalize output
normalize error
create envelope
update node status
return action
```

Standard node envelope:

```js
{
  success: true,
  status: "completed",
  data: {},
  error: null,
  billing: {},
  security: {},
  metadata: {}
}
```

## 8. Queue Architecture

Target queue-first flow:

```txt
run-usecase job
  -> initializes run
  -> enqueue orchestration job

orchestration job
  -> checks ready nodes
  -> enqueue node-execute jobs

node-execute job
  -> runs one node
  -> enqueue orchestration job
```

Avoid recursive synchronous execution for production workflows.

## 9. Files to Add

```txt
apiOpenArt/src/models/modelService.js
apiOpenArt/src/models/modelCatalog.js
apiOpenArt/src/models/modelOperations.js
apiOpenArt/src/models/modelPricingService.js
apiOpenArt/src/models/pricingFormulas.js

apiOpenArt/src/v2/runtime/nodeRuntime.js
apiOpenArt/src/v2/runtime/nodeEnvelope.js
apiOpenArt/src/v2/runtime/nodeErrorPolicy.js
apiOpenArt/src/v2/runtime/canonicalRequests.js
apiOpenArt/src/v2/runtime/useCaseBillingRuntime.js
```

## 10. Files to Modify

```txt
apiOpenArt/src/services/useCaseService.js
apiOpenArt/src/use-cases/useCaseRunner.js
apiOpenArt/src/use-cases/definitions/*.js
apiOpenArt/src/v2/runner/workflowRunner.js
apiOpenArt/src/v2/runner/nodeExecutor.js
apiOpenArt/src/v2/nodes/imageGenerationNode.js
apiOpenArt/src/v2/nodes/videoGenerationNode.js
apiOpenArt/src/v2/providers/adapters/imageAdapter.js
apiOpenArt/src/v2/providers/adapters/videoAdapter.js
apiOpenArt/controllers/imageController.js
apiOpenArt/controllers/editImageController.js
apiOpenArt/controllers/videoController.js
apiOpenArt/controllers/projectController.js
```

## 11. Database Changes Later

Current `pricing_rules` is too simple for formula pricing.

Target pricing table:

```txt
pricing_rules
  id
  model_key
  provider_id nullable
  operation_type
  pricing_mode
  rule_json
  is_active
  effective_from
  effective_until
```

Run billing metadata should store:

```txt
billing_mode
billing_status
billing_reference_id
reserved_credits
settled_credits
refunded_credits
billing_breakdown
```

## 12. Implementation Phases

### Phase 1: Model foundation

Add:

```txt
modelOperations
pricingFormulas
modelCatalog wrapper
modelPricingService
modelService
```

No execution changes yet.

### Phase 2: UseCase prepare and reserve

Add:

```txt
UseCaseService.prepareAndEnqueue
```

It validates, compiles, calculates, reserves, creates run metadata, then enqueues.

### Phase 3: Apply to image-generation-v1

Use the new path for one usecase first.

Goal:

```txt
image-generation-v1 reserves credits before queue.
```

### Phase 4: Add worker guard

Paid run cannot execute without reserved hold.

### Phase 5: Add NodeRuntime and envelope

Move node execution lifecycle out of `nodeExecutor` gradually.

### Phase 6: Add ModelExecutionService

Image/video nodes call one model execution service instead of manual provider routing.

### Phase 7: Add ErrorPolicy

Centralize retry/stop/refund decisions.

### Phase 8: Queue-first orchestration

Replace direct recursive node execution with queue jobs.

### Phase 9: Migrate remaining usecases/controllers

Move all generation/edit/upscale/video usecases through the new path.

### Phase 10: DB pricing migration

Upgrade `pricing_rules` to formula-based rules.

## 13. First Commit Scope

Recommended first commit:

```txt
1. Add this implementation plan document.
2. Add modelOperations.js.
3. Add pricingFormulas.js.
4. Add modelCatalog.js as a wrapper over current IMAGE_ROUTES and MODEL_ROUTES.
5. Add modelPricingService.js using router fallback first.
6. Add modelService.js facade.
```

This first commit should not change live execution.

## 14. Final Success Criteria

The refactor is successful when:

```txt
1. Controllers do not calculate model cost.
2. Controllers do not decide provider payloads.
3. UseCaseService reserves credits before queue.
4. Worker refuses paid runs without a hold.
5. ModelService answers all model/provider/pricing questions.
6. Pricing supports quality, duration, per-second, scale, fixed formulas.
7. NodeRuntime produces standard envelopes.
8. ErrorPolicy controls rollback/settle/retry decisions.
9. Frontend price and backend reserved price come from the same source.
10. Adding a model means defining it once, providers once, and pricing once.
```

## 15. Implemented Runtime Notes - 2026-08-21

Status: first runtime slice implemented.

Implemented modules:

```txt
apiOpenArt/src/models/modelOperations.js
apiOpenArt/src/models/pricingFormulas.js
apiOpenArt/src/models/modelCatalog.js
apiOpenArt/src/models/modelPricingService.js
apiOpenArt/src/models/modelService.js
apiOpenArt/src/v2/runtime/canonicalRequests.js
apiOpenArt/src/v2/runtime/errorPolicy.js
apiOpenArt/src/v2/runtime/nodeEnvelope.js
apiOpenArt/src/v2/runtime/useCaseBillingRuntime.js
apiOpenArt/src/use-cases/workflowBillingPlan.js
```

Implemented runtime boundary:

```txt
Controller
  -> UseCaseService.prepareAndEnqueue()
    -> validate usecase input
    -> compile workflow
    -> calculate billable workflow plan
    -> reserve credits before queue
    -> enqueue job with billingHoldId

Worker
  -> UseCaseService.executeQueuedUseCase()
    -> reject paid jobs without billingHoldId
    -> run workflow
    -> settle billing on success
    -> rollback billing on final failure
    -> attach ErrorPolicy decision on failure
```

Important decision:

```txt
The controller may save free local state first, like a character row, but no paid provider job enters the queue until the full estimated billable amount is reserved.
```

Applied controller flows:

```txt
character create:
  save character first
  reserve character-sheet workflow cost
  enqueue only if reserve succeeds
  if reserve fails, return saved=true + needsCredits=true

character sheet regenerate:
  update prompt/state
  create processing media placeholder
  reserve workflow cost
  enqueue only if reserve succeeds

edit image:
  aligned controller usecase id to image-edit-v1
  normalized source_asset into canonical source_url input
```

Implemented queue contract:

```txt
job payload includes:
  useCaseId
  input
  userId
  workflowRunId
  billingHoldId
  idempotencyKey
  traceId
```

Implemented node status compatibility:

```txt
NodeExecutor keeps the existing raw output shape for workflow bindings.
It also stores the standard envelope inside output.__nodeEnvelope.
On failure, the failure envelope is stored inside error.envelope.
```

Current deliberate bridge:

```txt
ModelService wraps existing image/video routers first.
Routers and provider runners still execute the actual provider calls.
This gives one pricing/catalog facade without rewriting every runner in the first slice.
```

Validation added:

```txt
test_model_service_pricing.mjs
test_character_create_prepare_enqueue.mjs
test_character_sheet_regenerate.mjs
test_usecase_worker_guard.mjs
test_job_queue_service_contract.mjs
test_runtime_error_policy.mjs
scripts/v2/checkModelService.mjs
scripts/v2/checkUseCaseBillingRuntime.mjs
```
