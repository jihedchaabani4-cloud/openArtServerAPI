# UseCase Runtime, Billing, and Error Architecture

Date: 2026-08-20
Status: planning / source of truth before implementation

## 1. Goal

We want a professional backend UseCase system for OpenArt.

The system must make it easy to add new product actions like:

- `image-generation-v1`
- `image-edit-v1`
- `character-sheet-v1`
- `video-generation-v1`
- `upscale-v1`
- future edit/generation services

The controller should not know the internal workflow details. It should only call one service, and the backend engine handles:

- input validation
- workflow compilation
- billable node calculation
- upfront credit reserve before queue
- worker execution
- node errors
- refund / settle
- final run status
- media status

The most important rule:

```txt
No paid usecase enters the worker queue before credits are reserved.
```

This prevents double spending and prevents workers from doing expensive work for users who do not have enough credits.

## 2. Current Architecture Summary

The current backend already has a good foundation:

```txt
Controller
  -> UseCaseService / UseCaseRunner
  -> Workflow YAML
  -> WorkflowRunner
  -> NodeExecutor
  -> Node implementation
  -> DB status
```

Existing good pieces:

- `src/services/useCaseService.js`
- `src/services/jobQueueService.js`
- `src/workers/useCaseWorker.js`
- `src/use-cases/useCaseRunner.js`
- `src/use-cases/definitions/*`
- `src/v2/registry/workflows/*.yaml`
- `src/v2/runner/workflowRunner.js`
- `src/v2/runner/nodeExecutor.js`
- `src/v2/nodes/safety/NodeSafetyService.js`
- `v2_workflow_runs`
- `v2_workflow_run_nodes`

So the system is not missing from zero. The problem is that the rules are not centralized enough yet.

## 3. Current Problems

### 3.1 Multiple entrypoints

Some controllers use:

```txt
UseCaseService + JobQueueService
```

Other controllers still call:

```txt
useCaseRunner.run()
```

Problem:

- two execution paths
- inconsistent behavior
- easier to introduce bugs
- billing/security can be bypassed by mistake

Target:

```txt
All controllers must enter through UseCaseService only.
```

### 3.2 Billing happens too late in some flows

If credits are reserved inside the worker or per node only during execution, this can happen:

```txt
User has 10 credits.
UseCase A costs 10.
UseCase B costs 10.

Both jobs enter queue before reserve.
Both workers start.
Only one should be allowed.
```

Target:

```txt
UseCaseService calculates billable nodes and reserves total credits before enqueue.
```

### 3.3 Billing cost is not policy-driven enough

Current billing can be hardcoded by node type, for example:

```txt
image-generation = count
video-generation = duration
llm = 1
```

Problem:

- model prices change
- different usecases need different billing rules
- LLM can be free in one usecase and paid in another
- generate can be the only paid node in one usecase
- another usecase may charge LLM + generate

Target:

```txt
UseCase billing policy decides which nodes are billable.
PricingService decides model-based price.
BillingRuntime applies reserve/settle/rollback.
```

### 3.4 Errors are not centralized enough

Today many errors are normal JS errors:

```js
throw new Error("...")
```

Problem:

The system does not always know:

- should workflow stop?
- should node retry?
- should credits be refunded?
- should media be marked failed?
- what user-safe message should frontend see?

Target:

```txt
NodeRuntime catches all errors.
ErrorPolicy classifies them.
BillingRuntime refunds/settles based on the decision.
WorkflowRunner stops/retries/continues based on the decision.
```

### 3.5 Node output shapes are different

Examples:

- prompt builder returns `{ finalPrompt, context }`
- LLM returns `{ text, json, is_safe }`
- image generation returns `{ assets, metadata }`

Problem:

Harder to inspect and debug node status, billing, security, and error state.

Target:

Use a standard envelope internally:

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

For compatibility, existing workflow bindings can still read from raw `output` first. The envelope can be stored as execution metadata until all workflows migrate.

### 3.6 Security is inside node implementations

Many nodes already call `NodeSafetyService`, which is good.

Problem:

If a new node forgets to call safety validation, it can reach the provider with unsafe or invalid input.

Target:

```txt
NodeRuntime enforces validation/security based on node manifest before provider execution.
```

## 4. New Target Architecture

The target architecture:

```txt
Controller
  -> UseCaseService.prepareAndEnqueue()
    -> validate usecase input
    -> compile workflow
    -> calculate billable nodes
    -> reserve total credits
    -> create workflow run with billing hold
    -> enqueue job
  -> return taskId

Worker
  -> UseCaseRunner / WorkflowRunner
  -> NodeRuntime
    -> validate node inputs
    -> security check
    -> execute node
    -> normalize output/error
    -> update node status
  -> BillingRuntime settle/rollback
  -> final workflow status
```

Short version:

```txt
Controller receives request.
UseCaseService reserves money before queue.
Worker executes only reserved runs.
NodeRuntime controls each node.
ErrorPolicy decides what happens on failure.
BillingRuntime settles or refunds.
```

## 5. Responsibility Map

### Controller

Responsible for:

- reading HTTP request
- extracting user id
- normalizing request fields only if needed
- calling `UseCaseService.prepareAndEnqueue`
- returning `taskId`, `workflowId`, `status`

Not responsible for:

- calculating credits
- reserving credits directly
- executing nodes
- deciding refund
- deciding retry
- provider-specific logic

### UseCaseService

Responsible for:

- finding usecase definition
- validating usecase input
- compiling workflow
- reading usecase billing policy
- asking BillingRuntime to estimate and reserve credits
- creating run record with billing hold
- enqueueing usecase job
- exposing status APIs later

This is the official backend entrypoint.

### BillingRuntime / BillingService

Responsible for:

- calculating billable nodes
- resolving model/quality/count/duration fields
- using `PricingService` for model price
- reserving total credits before queue
- storing billing hold/reference id
- settling credits after successful workflow
- rolling back credits on failed/blocked workflow
- protecting against double spend

### Worker

Responsible for:

- processing queued jobs
- loading existing run
- executing workflow

Not responsible for:

- starting paid work without a billing hold
- calculating whether the user can afford the usecase

### WorkflowRunner / Orchestrator

Responsible for:

- determining which node is ready
- respecting node dependencies
- stopping workflow if a terminal error occurs
- marking workflow completed/failed

### NodeRuntime

Responsible for:

- resolving inputs for one node
- loading node manifest
- validating inputs
- enforcing safety/security
- executing node implementation
- validating output
- creating success/failure envelope
- updating node status
- reporting errors to ErrorPolicy

### Node Implementation

Responsible only for the core job:

```txt
safe inputs -> provider/internal logic -> raw output
```

It should not decide billing or global error behavior.

### ErrorPolicy

Responsible for classifying errors:

- retryable or not
- refund or not
- stop workflow or continue
- user-safe message
- internal message
- severity

## 6. Billing Policy Design

Billing must be defined per usecase, because the same node type can be paid in one usecase and free in another.

Example: only generate is paid, LLM is free.

```js
{
  useCaseId: "image-generation-v1",
  billing: {
    mode: "upfront-reserve",
    refundOnFailure: true,
    nodes: {
      llm_translate: {
        billable: false
      },
      build_prompt: {
        billable: false
      },
      generate: {
        billable: true,
        pricing: "model-price",
        operation: "image-generation",
        modelField: "model",
        qualityField: "quality",
        quantityField: "count",
        refundOnFailure: true
      }
    }
  }
}
```

Example: LLM and generate are both paid.

```js
{
  useCaseId: "pro-prompt-and-generate-v1",
  billing: {
    mode: "upfront-reserve",
    refundOnFailure: true,
    nodes: {
      llm_enrich: {
        billable: true,
        pricing: "fixed",
        amount: 1,
        refundOnFailure: true
      },
      generate: {
        billable: true,
        pricing: "model-price",
        operation: "image-generation",
        modelField: "model",
        qualityField: "quality",
        quantityField: "count",
        refundOnFailure: true
      }
    }
  }
}
```

Supported billing modes:

```txt
free
upfront-reserve
```

Possible future modes:

```txt
subscription-included
admin-free
promo-credit
```

For now, the important mode is `upfront-reserve`.

## 7. Upfront Reserve Flow

For a paid usecase:

```txt
1. Controller calls UseCaseService.prepareAndEnqueue.
2. UseCaseService validates input.
3. UseCaseService compiles workflow.
4. BillingRuntime reads usecase billing policy.
5. BillingRuntime calculates cost for billable nodes.
6. BillingRuntime reserves total credits.
7. UseCaseService creates run with billing hold.
8. UseCaseService enqueues job.
9. Worker executes only after reserve exists.
```

Required invariant:

```txt
If billing mode is upfront-reserve, run must have billing_status = "reserved" before worker execution.
```

## 8. Billing Data to Store

At workflow run level:

```js
{
  run_id: "...",
  user_id: "...",
  use_case_id: "image-generation-v1",
  billing_mode: "upfront-reserve",
  billing_status: "reserved",
  billing_reference_id: "usecase:<runId>",
  reserved_credits: 8,
  settled_credits: 0,
  refunded_credits: 0,
  billing_breakdown: [
    {
      nodeId: "generate",
      nodeType: "image-generation",
      billable: true,
      operation: "image-generation",
      model: "flux-pro",
      quality: "standard",
      quantity: 2,
      unitCost: 4,
      totalCost: 8
    }
  ]
}
```

At node run level:

```js
{
  node_id: "generate",
  billing: {
    billable: true,
    reservedFromUseCase: true,
    allocatedCredits: 8,
    consumedCredits: 8,
    pricingSource: "model-price"
  }
}
```

If DB migration is not done immediately, this can first be stored in JSON columns already available, such as run metadata/error/output fields if suitable. Later we can add explicit columns.

## 9. Settlement and Refund Rules

### Successful workflow

```txt
reserved = 8
workflow completed
settle 8
billing_status = settled
```

### LLM safety blocks before generate

```txt
reserved = 8
LLM returns CONTENT_SAFETY_VIOLATION
generate does not run
workflow failed/blocked
rollback 8
billing_status = refunded
```

### Provider fails during generate

```txt
reserved = 8
generate fails
ErrorPolicy says refundOnFailure = true
rollback 8
billing_status = refunded
```

### Invalid input before reserve

```txt
input invalid
no reserve
no queue
return 400
```

### Insufficient credits

```txt
cost = 8
available = 4
reserve fails
no queue
return 402
```

## 10. Error Policy

Common error codes:

```txt
INVALID_INPUT
USE_CASE_NOT_FOUND
WORKFLOW_NOT_FOUND
COMPILATION_FAILED
INSUFFICIENT_CREDITS
CONTENT_SAFETY_VIOLATION
PROVIDER_TIMEOUT
PROVIDER_RATE_LIMIT
PROVIDER_FAILED
OUTPUT_INVALID
PERSISTENCE_FAILED
NODE_FAILED
ORCHESTRATION_DEADLOCK
```

Example policy:

```js
{
  code: "CONTENT_SAFETY_VIOLATION",
  retryable: false,
  workflowAction: "stop",
  refund: true,
  billingAction: "rollback",
  nodeStatus: "failed",
  runStatus: "failed",
  userMessage: "This request cannot be generated.",
  severity: "blocked"
}
```

Timeout policy:

```js
{
  code: "PROVIDER_TIMEOUT",
  retryable: true,
  workflowAction: "retry",
  refund: false,
  billingAction: "hold",
  userMessage: "Generation timed out. Retrying..."
}
```

Final timeout failure:

```js
{
  code: "PROVIDER_TIMEOUT",
  retryable: false,
  workflowAction: "stop",
  refund: true,
  billingAction: "rollback",
  userMessage: "Generation failed. Credits were returned."
}
```

## 11. Node Result Envelope

Every node execution should internally produce an envelope:

```js
{
  success: true,
  status: "completed",
  data: {
    assets: []
  },
  error: null,
  billing: {
    billable: true,
    allocatedCredits: 8,
    consumedCredits: 8,
    model: "flux-pro",
    operation: "image-generation"
  },
  security: {
    checked: true,
    safe: true,
    flags: []
  },
  metadata: {
    runId: "...",
    nodeId: "generate",
    nodeType: "image-generation",
    durationMs: 12000,
    attempt: 1,
    provider: "fal"
  }
}
```

Failure envelope:

```js
{
  success: false,
  status: "failed",
  data: null,
  error: {
    code: "CONTENT_SAFETY_VIOLATION",
    message: "This request cannot be generated.",
    internalMessage: "...",
    retryable: false,
    workflowAction: "stop",
    billingAction: "rollback"
  },
  billing: {
    billable: false,
    allocatedCredits: 0,
    consumedCredits: 0
  },
  security: {
    checked: true,
    safe: false,
    flags: ["sexual_content"]
  },
  metadata: {
    runId: "...",
    nodeId: "llm_translate",
    nodeType: "llm",
    durationMs: 900
  }
}
```

Compatibility decision:

```txt
Keep existing `output` as raw node data for current workflow bindings.
Store envelope as `execution_meta` or equivalent metadata.
Later, migrate bindings to `output.data.*` if desired.
```

## 12. Example: Image Generation With Paid Generate Only

Policy:

```txt
llm_translate = free
build_prompt = free
generate = paid by model/count
```

Input:

```js
{
  prompt: "a cinematic portrait",
  model: "flux-pro",
  quality: "standard",
  count: 2
}
```

Pricing:

```txt
flux-pro image-generation standard = 4 credits per image
count = 2
total = 8
```

Flow:

```txt
Controller
  -> UseCaseService
  -> compile image-generation-v1 workflow
  -> BillingRuntime calculates 8
  -> reserve 8
  -> create run
  -> enqueue job
  -> return taskId

Worker
  -> llm_translate runs
  -> build_prompt runs
  -> generate runs
  -> workflow completed
  -> settle 8
```

If LLM blocks prompt:

```txt
reserve already exists = 8
llm_translate detects unsafe content
generate is not executed
rollback 8
workflow failed
frontend receives blocked message
```

## 13. Example: Double Spend Protection

User has 10 credits.

UseCase A costs 10.
UseCase B costs 10.

Correct behavior:

```txt
A prepareAndEnqueue:
  reserve 10
  available becomes 0
  queue A

B prepareAndEnqueue:
  tries reserve 10
  fails with INSUFFICIENT_CREDITS
  no queue
```

This is why reserve must happen before queue.

## 14. Implementation Plan

### Phase 1: Fix entrypoints and naming

- Make all controllers call `UseCaseService`.
- Do not call `useCaseRunner.run()` directly from controllers.
- Fix `image-edit-v1` naming mismatch.
- Fix `image-edit-v1` input mismatch between `source_url` and `source_asset`.

### Phase 2: Add billing preparation before queue

Add or extend:

```txt
src/services/useCaseService.js
```

New method:

```js
prepareAndEnqueue({
  useCaseId,
  input,
  userId
})
```

Responsibilities:

```txt
validate input
compile workflow
calculate billable nodes
reserve total credits
create run or execution metadata
enqueue job
return taskId/runId
```

### Phase 3: Add runtime modules

Create:

```txt
src/v2/runtime/nodeEnvelope.js
src/v2/runtime/nodeErrorPolicy.js
src/v2/runtime/useCaseBillingRuntime.js
src/v2/runtime/nodeRuntime.js
src/v2/runtime/nodeSecurityPolicy.js
```

### Phase 4: Move billing out of hardcoded workflowRunner switch

Replace hardcoded estimates with:

```txt
UseCase billing policy + PricingService
```

The workflow runner should not decide pricing by itself.

### Phase 5: Make worker require billing hold for paid runs

Before executing a paid run:

```txt
if billing_mode = upfront-reserve and billing_status != reserved:
  fail run before provider execution
```

### Phase 6: Centralize error handling

Node errors should go through:

```txt
NodeRuntime -> ErrorPolicy -> BillingRuntime -> WorkflowRunner
```

### Phase 7: Add status/control API

Later add:

```txt
GET /api/usecases/runs/:runId
POST /api/usecases/runs/:runId/cancel
POST /api/usecases/runs/:runId/retry-node/:nodeId
```

## 15. Final Rule Set

These rules define the pro system:

```txt
1. Controller never executes billing logic directly.
2. Controller never starts worker work directly.
3. UseCaseService is the only official entrypoint.
4. Paid usecases must reserve credits before queue.
5. Worker must not execute paid runs without a valid billing hold.
6. UseCase billing policy decides which nodes are billable.
7. PricingService decides model/quality/unit prices.
8. NodeRuntime owns node execution lifecycle.
9. ErrorPolicy owns retry/stop/refund decisions.
10. BillingRuntime owns reserve/settle/rollback.
11. Node implementation only performs its core provider/internal work.
12. Every node execution gets a standard envelope.
```

## 16. First Practical Code Targets

The first real implementation should touch these areas:

```txt
apiOpenArt/src/services/useCaseService.js
apiOpenArt/src/use-cases/useCaseRunner.js
apiOpenArt/src/use-cases/definitions/imageEdit.js
apiOpenArt/src/v2/registry/workflows/image-edit-v1.yaml
apiOpenArt/controllers/editImageController.js
apiOpenArt/src/v2/runtime/*
apiOpenArt/src/v2/runner/nodeExecutor.js
apiOpenArt/src/v2/runner/workflowRunner.js
```

Recommended first commit:

```txt
1. Add this architecture doc.
2. Fix image-edit usecase naming/input mismatch.
3. Add UseCaseService.prepareAndEnqueue skeleton.
4. Add billing runtime skeleton for upfront reserve.
```

## 17. Implemented Billing and Error Flow - 2026-08-21

Status: first production-oriented slice implemented.

### 17.1 Who owns what now?

```txt
Controller:
  saves local/free product state
  calls UseCaseService.prepareAndEnqueue()
  returns queued/saved/needsCredits response

UseCaseService:
  official entrypoint for paid queued usecases
  validates input
  compiles workflow
  calculates billable nodes
  reserves credits before enqueue
  creates the job payload contract
  settles/rolls back after worker execution

WorkflowBillingPlan:
  scans compiled workflow nodes
  decides which nodes are billable
  asks ModelService for each model cost
  returns total estimated reserve amount

ModelService:
  model validation
  default provider metadata
  model/quality/duration/scale cost calculation

UseCaseBillingRuntime:
  reserve
  settle/commit
  rollback/refund
  idempotent billing reference handling

JobQueueService:
  accepts only prepared queue payloads
  carries billingHoldId/idempotencyKey/traceId to worker

UseCaseWorker:
  refuses paid jobs without billingHoldId
  delegates execution to UseCaseService.executeQueuedUseCase()

ErrorPolicy:
  classifies runtime errors
  decides retryable/final failure semantics
  provides safe failure metadata for rollback/logging

NodeExecutor:
  executes existing node implementation
  records running/completed/failed DB status
  attaches standard success/failure envelope
```

### 17.2 Current request lifecycle

```txt
1. HTTP controller receives request.
2. Controller saves local state if needed.
3. Controller calls UseCaseService.prepareAndEnqueue().
4. UseCaseService validates usecase input.
5. UseCaseService compiles the workflow.
6. WorkflowBillingPlan calculates all billable nodes.
7. UseCaseBillingRuntime reserves the full estimated amount.
8. JobQueueService enqueues only after reserve succeeds.
9. Worker receives job with billingHoldId.
10. Worker refuses execution if the paid job has no hold.
11. Workflow executes nodes.
12. NodeExecutor stores node envelope/status.
13. UseCaseService settles credits on final success.
14. UseCaseService rolls back credits on final failure.
```

### 17.3 Character create rule

The implemented character creation flow follows the clarified product rule:

```txt
Character row can be saved first.
Paid character-sheet generation is reserved second.
If reserve fails, the character remains saved.
No paid provider job is queued.
Response reports needsCredits.
```

This means a user does not lose their character draft, and the backend still protects provider work from running without reserved credits.

### 17.4 Billing policy rule

The first implemented rule is all-or-nothing upfront reserve:

```txt
Reserve:
  sum all billable nodes before queue

Success:
  commit/settle the hold once

Failure:
  rollback/refund the hold once
```

Per-node partial settlement can be added later, but the first slice intentionally keeps settlement simple so duplicate workers and partial failures are easier to reason about.

### 17.5 Node envelope compatibility

The node envelope exists without breaking current workflow bindings:

```txt
success:
  output keeps existing fields
  output.__nodeEnvelope stores normalized runtime metadata

failure:
  error.code and error.message stay readable
  error.envelope stores normalized runtime metadata
```

Envelope responsibilities:

```txt
status
success/failure
safe error object
billing metadata hook
security metadata hook
node/run trace metadata
durationMs
timestamp
```

### 17.6 Implemented guardrails

```txt
Paid job without billingHoldId:
  rejected before provider execution

Reserve failure:
  no queue job is created

Worker failure:
  ErrorPolicy decision attached
  billing rollback attempted

Successful workflow:
  billing settlement attempted

Queue payload:
  workflowRunId, billingHoldId, idempotencyKey, traceId included
```

### 17.7 Remaining runtime improvements

```txt
1. Persist billing hold fields on workflow run rows.
2. Move DB pricing_rules behind ModelPricingService as the primary source.
3. Add structured logs for every reserve/queue/settle/rollback decision.
4. Add retry policy integration for transient provider errors.
5. Add per-node partial settlement only after all-or-nothing flow is stable.
6. Add status APIs for frontend run/node inspection.
7. Migrate every remaining controller entrypoint to UseCaseService only.
```
