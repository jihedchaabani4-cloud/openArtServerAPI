# Full Backend System Deep Analysis and Target Architecture

Date: 2026-08-21
Status: architecture analysis / planning reference

Related documents:

- `docs/usecase-runtime-billing-architecture.md`
- `docs/model-system-deep-analysis.md`

## 1. Goal

We want to understand the current backend system as one connected machine, then define how to make it much stronger.

The main systems involved are:

```txt
1. Controllers / HTTP entrypoints
2. UseCase system
3. Queue and workers
4. Workflow runner / node executor
5. Model and provider execution
6. Pricing and billing
7. Wallet holds / settlement / rollback
8. Errors, security, and status reporting
```

The final target is:

```txt
Thin controllers
  -> one UseCase entrypoint
  -> upfront credit reserve before queue
  -> clean worker execution
  -> manifest/policy-driven NodeRuntime
  -> ModelCatalog + provider profiles
  -> PricingEngine with formulas
  -> standard errors and status
```

## 2. Current System Map

Current simplified flow:

```txt
Controller
  -> UseCaseService or direct UseCaseRunner
  -> compile workflow YAML
  -> create workflow run
  -> execute orchestration
  -> execute node
  -> node calls model/provider
  -> billing hold/settle/rollback can happen per node
  -> DB status updated
```

Important files:

```txt
apiOpenArt/src/services/useCaseService.js
apiOpenArt/src/services/jobQueueService.js
apiOpenArt/src/workers/useCaseWorker.js
apiOpenArt/src/use-cases/useCaseRunner.js
apiOpenArt/src/v2/runner/workflowRunner.js
apiOpenArt/src/v2/runner/nodeExecutor.js
apiOpenArt/src/platform/billing/WalletService.js
apiOpenArt/src/platform/billing/PricingService.js
apiOpenArt/src/image/core/modelRouter.js
apiOpenArt/src/video/core/modelRouter.js
apiOpenArt/src/v2/providers/adapters/imageAdapter.js
apiOpenArt/src/v2/providers/adapters/videoAdapter.js
```

## 3. What Is Already Good

The system is not bad. It already has many strong parts:

### 3.1 UseCases exist

There are usecase definitions:

```txt
image-generation-v1
image-edit-v1
video-generation-v1
video-edit-v1
character-sheet-v1
camera-control-v1
lighting-control-v1
upscale-v1
```

These are registered by `registerUseCases.js`.

### 3.2 Workflows exist as YAML

V2 workflows are defined in:

```txt
apiOpenArt/src/v2/registry/workflows/*.yaml
```

They define:

- nodes
- dependencies
- inputs
- outputs
- persistence rules

### 3.3 Queue service exists

`jobQueueService.js` has:

```txt
addUseCaseJob
addNodeExecutionJob
getJobStatus
removeJob
```

### 3.4 Worker exists

`useCaseWorker.js` handles:

```txt
run-usecase
node-execute
orchestration
```

### 3.5 Node executor exists

`nodeExecutor.js` already:

- resolves inputs
- updates node status
- reserves billing
- executes node
- persists output
- settles billing
- rolls back on error
- updates media to failed on error

### 3.6 Wallet hold system exists

`WalletService` supports:

```txt
hold
commit / commitHoldIdempotent
rollback
credit
expireStaleHolds
```

This is exactly the right foundation for upfront reserve.

### 3.7 Provider adapters exist

Image/video providers already use:

```txt
adapt(form)
toPayload(adapted)
generate(payload)
```

This is good. It means provider-specific payload differences are already handled per runner.

### 3.8 Model routers exist

Image and video routers already map public model keys to runner registries:

```txt
IMAGE_ROUTES
MODEL_ROUTES
```

They also contain model capability and pricing metadata.

## 4. Main Current Problems

### 4.1 Too many entrypoints

Some controllers use:

```txt
UseCaseService + jobQueueService
```

Some still call:

```txt
useCaseRunner.run()
```

Problem:

```txt
Different controllers can bypass different parts of the intended flow.
```

Target:

```txt
Every paid/AI usecase enters through UseCaseService.prepareAndEnqueue.
```

### 4.2 Billing can happen too late

Current V2 node execution can reserve billing inside `executeNodeJob`.

Problem:

If reserve happens only inside worker/node execution, a user can enqueue multiple expensive jobs before credits are held.

Target:

```txt
UseCaseService calculates total billable cost and reserves before queue.
Worker executes only if the run has a valid billing hold.
```

### 4.3 Pricing has multiple sources

Current pricing sources:

```txt
1. image modelRouter pricing
2. video modelRouter pricing
3. lib/pricingUtils.js
4. src/config/pricing.js / APP_PRICING
5. PricingService DB table pricing_rules
6. BudgetEstimator fallback values
7. legacy treatment pricing
```

Problem:

UI price, wallet price, actual reserve, and package comparison can disagree.

Target:

```txt
PricingEngine / ModelPricingService is the only runtime pricing calculator.
PricingService DB is the source of truth for actual billing.
Router pricing is fallback/seed/dev metadata only.
```

### 4.4 Model/provider system is strong but not centralized

Current runners have `adapt` and `toPayload`, which is good.

Problem:

The system lacks a single catalog that says:

```txt
model X can run on providers A/B/C
default provider is A
fallback provider is B
provider A runner key is ...
provider B runner key is ...
```

Target:

```txt
ModelCatalog owns model identity, providers, default provider, fallback providers, capabilities, and runner resolution.
```

### 4.5 Canonical request is implicit

Runners currently accept `form`, but fields are inconsistent:

```txt
ratio / aspectRatio / aspect_ratio
quality / resolution
image / image_base64 / source_asset / source_url
references / input_assets
duration / durationSeconds
```

Target:

Define official internal request contracts:

```txt
CanonicalImageRequest
CanonicalVideoRequest
CanonicalLLMRequest
```

Runner `adapt()` receives canonical request, not random controller form.

### 4.6 Error handling is not centralized enough

Errors can be thrown from:

- controller
- usecase runner
- workflow compiler
- node executor
- node implementation
- provider runner
- wallet service
- pricing service

Problem:

The system does not always decide consistently:

```txt
retry?
stop workflow?
refund?
mark media failed?
show what to frontend?
```

Target:

```txt
ErrorPolicy normalizes every error and decides workflow action + billing action.
```

### 4.7 Workflow orchestration is partly synchronous

`workflowRunner.executeOrchestration()` currently can call:

```txt
await executeNodeJob(runId, node.id)
return await executeOrchestration(runId)
```

Problem:

Queue exists, but execution can be recursive/synchronous in one process.

Target:

```txt
Queue-first execution:
orchestration job -> node jobs -> orchestration job -> next node jobs.
```

### 4.8 Node outputs are not uniform

Different nodes return different raw shapes:

```txt
prompt-builder -> finalPrompt/context
llm -> text/json/is_safe
image-generation -> assets/metadata
video-generation -> asset/metadata
```

Target:

```txt
Every node execution gets an envelope:
success, status, data, error, billing, security, metadata.
```

## 5. Current Billing System Detail

### 5.1 WalletService

`WalletService` already supports the right transaction lifecycle:

```txt
hold: subtract credits and create PENDING debit
commit: mark hold COMPLETED
rollback: mark hold FAILED and restore balance
credit: add credits
expireStaleHolds: release old pending holds
```

This is very good.

### 5.2 WorkflowBillingGateway

The gateway wraps wallet operations:

```txt
reserve -> walletService.hold
settle -> commitHoldIdempotent / commit
rollback -> walletService.rollback
```

This is also good.

### 5.3 Current V2 issue

Billing is currently tied to node execution:

```txt
nodeExecutor -> reserveNodeBilling -> execute node -> settleNodeBilling
```

But your requirement is:

```txt
reserve total usecase cost before queue.
```

So the new design should change from:

```txt
reserve per node during worker execution
```

to:

```txt
reserve total usecase before queue
allocate cost per billable node during execution
settle/rollback the whole hold at workflow end
```

## 6. Target Billing Flow

For paid usecases:

```txt
Controller
  -> UseCaseService.prepareAndEnqueue
    -> validate input
    -> compile workflow
    -> resolve billable nodes from usecase billing policy
    -> calculate cost with ModelPricingService
    -> wallet hold total credits
    -> create workflow run with billing hold metadata
    -> enqueue job
    -> return taskId
```

Worker:

```txt
Worker loads run
  -> if paid usecase and no billing hold: fail before provider work
  -> execute workflow
  -> on success: settle hold
  -> on failure/refund case: rollback hold
```

Invariant:

```txt
No paid provider call without a reserved billing hold.
```

## 7. Target Model and Provider System

### 7.1 Model has many providers

A model should not equal one provider.

Example:

```js
{
  key: "gpt-image-2",
  domain: "image",
  defaultProvider: "wavespeed",
  providers: {
    wavespeed: {
      enabled: true,
      runnerKey: "gpt_image_2_wavespeed",
      providerSlug: "openai/gpt-image-2",
      priority: 1
    },
    fal: {
      enabled: true,
      runnerKey: "gpt_image_2_fal",
      providerSlug: "fal-ai/gpt-image-2",
      priority: 2
    }
  }
}
```

### 7.2 Provider input differences are handled by runners

Current runner interface is good:

```txt
adapt(canonicalRequest)
toPayload(adapted)
generate(payload)
```

Target:

Keep this interface, but make the input canonical and documented.

### 7.3 ModelExecutionService

Add a layer:

```txt
ModelExecutionService.execute(canonicalRequest)
  -> ModelCatalog.resolveExecutionTarget
  -> get provider profile
  -> get runner
  -> runner.adapt
  -> runner.toPayload
  -> runner.generate
  -> normalize output
```

This means nodes do not manually choose adapters/runners.

## 8. Target Pricing System

### 8.1 Pricing must support formulas

Models do not all cost the same way.

Supported pricing modes should include:

```txt
fixed
quality_table
duration_resolution_table
per_second
scale_table
token_based
```

### 8.2 Example image quality table

```js
{
  modelKey: "gpt-image-2",
  operation: "IMAGE_GENERATION",
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

### 8.3 Example video table

```js
{
  modelKey: "kling_v3",
  operation: "VIDEO_GENERATION",
  pricingMode: "duration_resolution_table",
  rule: {
    table: {
      "720p": { "3": 25, "5": 42, "10": 84 },
      "1080p": { "3": 35, "5": 60, "10": 120 }
    }
  }
}
```

### 8.4 Example per-second video

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

### 8.5 Proposed DB shape

Current `pricing_rules` table is too simple for all future formulas.

Target table shape:

```txt
model_key
provider_id nullable
operation_type
pricing_mode
rule_json
is_active
effective_from
effective_until
```

This can support all formulas without new columns every time.

## 9. Target Error System

### 9.1 ErrorPolicy

Add a policy layer that classifies errors:

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

Each error gets:

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

### 9.2 Billing actions

```txt
before reserve failure -> no queue
after reserve + safety block -> rollback
after reserve + provider final failure -> rollback
after success -> settle
retryable provider error -> keep hold until final result
```

## 10. Target Node Runtime

Today `nodeExecutor` owns many responsibilities.

Target:

```txt
nodeExecutor
  -> load run/node
  -> delegate to NodeRuntime
```

`NodeRuntime` owns:

```txt
resolve inputs
load node manifest
validate inputs
security checks
build canonical request
execute model/provider if needed
normalize output
create envelope
update node status
return action to workflow runner
```

Node implementation should only do:

```txt
safe input -> core logic -> raw result
```

## 11. Proposed New Modules

Add these modules gradually:

```txt
apiOpenArt/src/models/modelCatalog.js
apiOpenArt/src/models/modelOperations.js
apiOpenArt/src/models/modelExecutionService.js
apiOpenArt/src/models/modelPricingService.js
apiOpenArt/src/models/pricingFormulas.js

apiOpenArt/src/v2/runtime/nodeRuntime.js
apiOpenArt/src/v2/runtime/nodeEnvelope.js
apiOpenArt/src/v2/runtime/nodeErrorPolicy.js
apiOpenArt/src/v2/runtime/useCaseBillingRuntime.js
apiOpenArt/src/v2/runtime/canonicalRequests.js
```

These should initially wrap the existing routers/runners rather than replace them.

## 12. Implementation Phases

### Phase 1: Lock entrypoint

Goal:

```txt
All AI/product usecases go through UseCaseService.
```

Work:

- add `prepareAndEnqueue`
- migrate controllers away from direct `useCaseRunner.run`
- fix usecase naming mismatches
- return consistent task/run response

### Phase 2: Add ModelCatalog facade

Goal:

```txt
One API to answer model/provider questions.
```

Work:

- wrap existing `IMAGE_ROUTES` and `MODEL_ROUTES`
- normalize aliases
- expose `getModel`, `listPublicModels`, `resolveRunner`
- expose provider profiles/default provider/fallback list

### Phase 3: Add pricing formulas

Goal:

```txt
One runtime cost calculator.
```

Work:

- add `pricingFormulas`
- add `ModelPricingService`
- support fixed, quality table, video table, per-second, scale table
- map existing router pricing into formula shape as fallback

### Phase 4: Upfront reserve before queue

Goal:

```txt
No queue for paid usecase without reserved credits.
```

Work:

- use usecase billing policy to find billable nodes
- calculate total cost
- call wallet hold
- store hold reference on run
- enqueue only after hold success

### Phase 5: Worker guard

Goal:

```txt
Worker refuses paid runs without valid hold.
```

Work:

- check run billing metadata before provider work
- fail fast if invariant broken

### Phase 6: NodeRuntime and error policy

Goal:

```txt
Centralize node status/error/security/output envelope.
```

Work:

- add `NodeRuntime`
- add `NodeEnvelope`
- add `ErrorPolicy`
- migrate `nodeExecutor` gradually

### Phase 7: ModelExecutionService

Goal:

```txt
Nodes execute models through one service.
```

Work:

- image node calls `ModelExecutionService`
- video node calls `ModelExecutionService`
- output stores model/provider metadata
- provider fallback handled in one place

### Phase 8: Queue-first orchestration

Goal:

```txt
No recursive synchronous node execution for production workflow.
```

Work:

- orchestration job only enqueues ready node jobs
- node job executes one node
- node completion enqueues orchestration job

### Phase 9: Status/control API

Goal:

```txt
Frontend can inspect exactly what happened.
```

Endpoints:

```txt
GET /api/usecases/runs/:runId
POST /api/usecases/runs/:runId/cancel
POST /api/usecases/runs/:runId/retry-node/:nodeId
```

Status includes:

```txt
run status
current node
node envelopes
billing breakdown
error policy decision
model/provider metadata
```

## 13. Recommended First Build Slice

Do not try to rewrite everything at once.

First slice:

```txt
1. Add ModelCatalog wrapper.
2. Add canonical operation enum.
3. Add pricing formulas and ModelPricingService.
4. Add UseCaseService.prepareAndEnqueue skeleton.
5. Use it for image-generation-v1 first.
6. Keep existing runners/adapt/toPayload unchanged.
```

Why this first:

```txt
It solves the biggest money risk first:
reserve before queue.
It also avoids breaking provider execution.
```

## 14. Final Target Shape

Final system:

```txt
Controller
  -> UseCaseService.prepareAndEnqueue
    -> UseCaseRegistry
    -> WorkflowCompiler
    -> ModelCatalog
    -> ModelPricingService
    -> BillingRuntime.reserve
    -> JobQueueService

Worker
  -> WorkflowOrchestrator
  -> NodeRuntime
    -> ModelExecutionService
      -> ModelCatalog
      -> Runner.adapt
      -> Runner.toPayload
      -> Runner.generate
    -> NodeEnvelope
  -> ErrorPolicy
  -> BillingRuntime.settle/rollback
```

## 15. Core Rules

```txt
1. Controllers do not calculate prices.
2. Controllers do not call providers.
3. Controllers do not reserve wallet directly.
4. UseCaseService is the only paid execution entrypoint.
5. Paid usecases reserve before queue.
6. Worker does not execute paid work without a hold.
7. ModelCatalog owns model/provider/routing metadata.
8. Runners own provider-specific adapt/toPayload/generate.
9. ModelPricingService owns formula-based cost calculation.
10. PricingService DB is source of truth for production prices.
11. ErrorPolicy owns retry/stop/refund decisions.
12. Every node gets a standard execution envelope.
```

## 16. Bottom Line

The existing backend is not useless or wrong. It already has many strong foundations:

```txt
UseCases exist.
Workflow YAML exists.
Queue exists.
Wallet holds exist.
Provider runners already adapt payloads.
Model routers exist.
```

The real work is to connect these pieces with one professional runtime:

```txt
UseCaseRuntime
ModelCatalog
PricingEngine
NodeRuntime
ErrorPolicy
BillingRuntime
```

That is the clean path to a much stronger system.

