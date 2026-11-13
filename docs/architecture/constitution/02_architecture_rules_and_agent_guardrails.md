# Universal Modular Monolith Architecture — Rules, Patterns & Agent Guardrails

> **Scope:** General-purpose backend architecture standard for any SaaS application (Node.js / Express / TypeScript / Python / Go).  
> **Core Philosophy:** **Black-Box Business Systems** inside a single deployable monolith — combining the strict isolation and clarity of microservices with the speed, simplicity, and transactional safety of a single process (inspired by [Shopify's Componentization & Packwerk](https://shopify.engineering/enforcing-modularity-rails-apps-packwerk)).

---

## 1. Architectural Overview: How the System Works

Instead of organizing code by technical file type (`controllers/`, `services/`, `repositories/`), the backend is organized by **independent Business Systems** (`src/systems/<system_name>/`).

Each Business System is a **self-contained black box**:
1. **Main Router (`src/app.js` / `src/routes.js`):** The single HTTP entry point. It applies global middlewares (CORS, rate limiting, request correlation ID, global error handler) and mounts each system's HTTP gateway (`public/api.js`).
2. **Business Systems (`src/systems/<system>/`):** Independent domain or platform modules. Each system owns its own routes, public tools, business logic, validators, and database tables.
3. **Background Workers (`src/workers/` or inside an async system):** Consume jobs from a queue (e.g., BullMQ, Redis, Temporal) and invoke Business Systems exclusively through their `public/tools.js` interface.
4. **Shared Technical Kernel (`src/shared/`):** Purely technical utilities with zero business logic (logger, env config, generic error base classes, correlation context).

### The Two-Gateway Rule (Per Business System)
Every Business System exposes **only what it needs** through at most two public files in `public/`:
- **`public/api.js` (Web Gateway — Optional):** Express/HTTP handlers (`req, res`) mounted by the Main Router. Omit this file if the system is internal-only and has no HTTP endpoints.
- **`public/tools.js` (Tools Interface — Optional):** Pure language-level async functions called by other Business Systems or background workers. Omit this file if no other system calls this system.
- **`internal/` (Strictly Private):** All internal services, helpers, schemas, and database repositories. **No external file may ever import from `internal/`.**

### Standard Folder Blueprint (Any SaaS)

```text
src/
├── app.js                         # Main Router: global middleware + mounts public/api.js
├── shared/                        # Pure technical utilities (NO business logic, NO DB queries)
│   ├── logger.js
│   ├── errors.js                  # Base AppError classes
│   └── config.js
└── systems/
    ├── <system_a>/                # Example: Has BOTH Web API + Tools for other systems
    │   ├── public/
    │   │   ├── api.js             # Mounted by src/app.js
    │   │   └── tools.js           # Imported by other systems via #<system_a>/tools
    │   └── internal/
    │       ├── services/          # Core business logic
    │       ├── db/                # Exclusive DB repositories & queries
    │       ├── validators/        # Input schemas
    │       └── errors.js          # System-prefixed errors
    ├── <system_b>/                # Example: HTTP-only orchestrator (NO tools.js)
    │   ├── public/
    │   │   └── api.js
    │   └── internal/
    │       └── ...
    └── <system_c>/                # Example: Internal engine only (NO api.js)
        ├── public/
        │   └── tools.js
        └── internal/
            └── ...
```

---

## 2. The 12 Strict Architecture Rules (Non-Negotiable)

### Rule 1: Two-Gateway Entry Points Only
A Business System must never expose internal classes, repositories, or helpers outside `public/api.js` and `public/tools.js`. If a system has no HTTP endpoints, omit `public/api.js`. If no other system calls it, omit `public/tools.js`.

### Rule 2: Sacred `internal/` Isolation
No file outside `src/systems/<name>/` (including other systems, the Main Router, workers, and integration tests) may import anything from `src/systems/<name>/internal/`.

### Rule 3: Main Router Purity
`src/app.js` (the Main Router) may only import `public/api.js` from each Business System. It must never contain business logic, database calls, or imports from `public/tools.js` or `internal/`.

### Rule 4: Zero Logic Duplication Between `api.js` and `tools.js`
`public/api.js` is a thin HTTP adapter. It extracts `userId`, validates `req.body` / `req.params`, calls the system's internal service (or `public/tools.js`), and formats the HTTP response. Business rules live once in `internal/services/`.

### Rule 5: Exclusive Database Table Ownership
Every database table is owned by **exactly one** Business System.
- **Allowed:** `billing` queries `wallets` and `credit_holds`.
- **Forbidden:** `orders` or `projects` querying `wallets` directly via SQL/ORM. They must call `billingTools.getBalance(userId)`.

### Rule 6: Database & External SDK Isolation
Database clients (`supabase`, `prisma`, `pg`, `mongoose`) and cloud storage SDKs (`S3`, `R2`) may only be imported inside `src/systems/<name>/internal/db/` (or a dedicated storage adapter inside the media/storage system). Never import DB clients inside `public/api.js`, `public/tools.js`, or `src/app.js`.

### Rule 7: Acyclic System Calls (Zero Circular Dependencies)
System A may call System B's `public/tools.js` whenever needed, **provided System B never calls System A** (no A -> B -> A cycles). Furthermore, no file inside `internal/` may import from its own system's `public/api.js` or `public/tools.js`.

### Rule 8: Plain Data Contracts (DTOs Only) Across Boundaries
Arguments and return values of `public/tools.js` must be plain JSON-serializable objects, primitives, or arrays.
- **Forbidden:** Passing Express `req`/`res`, DB connection/transaction objects, or internal class instances across system boundaries.

### Rule 9: System-Prefixed Error Hierarchy
Each system defines its own explicit error classes (e.g., `BillingInsufficientFundsError`, `MediaValidationError`, `ModelNotFoundError`) so callers and `public/api.js` can map errors cleanly without leaking internal stack traces or DB details.

### Rule 10: Two-Phase Resource Reservation for Async / Paid Operations
Any SaaS operation that consumes credits, quotas, or expensive external APIs must follow the **Reserve -> Dispatch -> Settle** protocol:
1. Check idempotency key (prevent double-clicks).
2. Reserve/hold credits or quota synchronously before queueing.
3. Dispatch async job to the queue inside a `try/catch` (if queueing fails, immediately release the hold).
4. Worker executes the job: on success, capture/finalize the hold; on failure, release/refund the hold.
5. Run a scheduled reaper job to release orphaned holds if a worker crashes.

### Rule 11: Extensibility via Registries (Open-Closed Principle)
To support future SaaS features without modifying core systems:
- **Catalog / Provider Systems:** Use a **Registry Pattern** to register new external providers, plans, or models in one config/adapter folder without adding `if/else` chains in orchestrators.
- **Storage / Media Systems:** Use a **Save-Type / Policy Registry** defining MIME types, size limits, and retention rules declaratively.
- **Workflow / Feature Systems:** Register new product workflows as isolated recipe files that reuse shared `billing`, `storage`, and `identity` tools.

### Rule 12: Automated Mechanical Enforcement
Boundaries must be enforced automatically via package subpath aliases and static analysis in CI / pre-commit hooks—never by manual code review alone.

---

## 3. Concrete Code Examples (Reusable Blueprint)

### Example A: Enforcing Boundaries with `package.json` `#imports`
Never use wildcard aliases like `"#systems/*": "./src/systems/*.js"` because they allow external callers to reach into `internal/`. Lock every alias to `public/` only:

```json
{
  "imports": {
    "#identity/api": "./src/systems/identity/public/api.js",
    "#identity/tools": "./src/systems/identity/public/tools.js",
    "#billing/api": "./src/systems/billing/public/api.js",
    "#billing/tools": "./src/systems/billing/public/tools.js",
    "#orders/api": "./src/systems/orders/public/api.js",
    "#orders/tools": "./src/systems/orders/public/tools.js"
  }
}
```
With this configuration, Node.js natively throws `ERR_PACKAGE_IMPORT_NOT_DEFINED` if any file tries to import `#billing/internal/db/walletRepo.js`.

### Example B: Inside a Business System (`public/api.js`, `public/tools.js`, `internal/`)

#### 1. `src/systems/billing/internal/services/walletService.js` (Private Logic)
```javascript
import { walletRepo } from '../db/walletRepo.js';
import { BillingInsufficientFundsError } from '../errors.js';

export const walletService = {
  async getBalance(userId) {
    return walletRepo.findBalanceByUserId(userId);
  },

  async reserveCredits({ userId, amount, idempotencyKey }) {
    const existing = await walletRepo.findHoldByKey(idempotencyKey);
    if (existing) return existing; // Idempotent retry protection

    const balance = await walletRepo.findBalanceByUserId(userId);
    if (balance < amount) {
      throw new BillingInsufficientFundsError(`Need ${amount}, available ${balance}`);
    }
    return walletRepo.createHold({ userId, amount, idempotencyKey });
  },

  async captureHold(holdId) {
    return walletRepo.markHoldCaptured(holdId);
  },

  async releaseHold(holdId, reason) {
    return walletRepo.markHoldReleased(holdId, reason);
  }
};
```

#### 2. `src/systems/billing/public/tools.js` (Public Tools Interface for Other Systems)
```javascript
import { walletService } from '../internal/services/walletService.js';

// Only plain objects (DTOs) enter and leave this boundary
export const billingTools = {
  getBalance: (userId) => walletService.getBalance(userId),
  reserveCredits: ({ userId, amount, idempotencyKey }) =>
    walletService.reserveCredits({ userId, amount, idempotencyKey }),
  captureHold: (holdId) => walletService.captureHold(holdId),
  releaseHold: (holdId, reason) => walletService.releaseHold(holdId, reason)
};
```

#### 3. `src/systems/billing/public/api.js` (Web Gateway Mounted by Main Router)
```javascript
import { Router } from 'express';
import { walletService } from '../internal/services/walletService.js';

export const billingRouter = Router();

billingRouter.get('/balance', async (req, res, next) => {
  try {
    const balance = await walletService.getBalance(req.user.id);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
});
```

### Example C: Main Router (`src/app.js`)
```javascript
import express from 'express';
import { identityRouter } from '#identity/api';
import { billingRouter } from '#billing/api';
import { ordersRouter } from '#orders/api';

const app = express();
app.use(express.json());

// Mount each system's Web Gateway directly
app.use('/api/auth', identityRouter);
app.use('/api/wallet', billingRouter);
app.use('/api/orders', ordersRouter);

export default app;
```

### Example D: Cross-System Call with Protected Queue Dispatch
```javascript
// Inside src/systems/orders/internal/services/orderService.js
import { billingTools } from '#billing/tools';
import { jobQueue } from '../queue/jobQueue.js';

export async function createAsyncOrder({ userId, amount, idempotencyKey, payload }) {
  // 1. Reserve credits via Billing's public tools
  const hold = await billingTools.reserveCredits({ userId, amount, idempotencyKey });

  // 2. Dispatch to queue with automatic rollback on failure
  try {
    const job = await jobQueue.enqueue({ userId, holdId: hold.id, payload });
    return { jobId: job.id, status: 'queued' };
  } catch (err) {
    await billingTools.releaseHold(hold.id, 'queue_dispatch_failed');
    throw err;
  }
}
```

---

## 4. Anti-Patterns: DO vs. DON'T

| Pattern | DON'T (Anti-Pattern) | DO (Correct Architecture) |
| :--- | :--- | :--- |
| **Cross-system DB access** | `import { WalletRepo } from '../../billing/internal/db/walletRepo.js'` | `import { billingTools } from '#billing/tools'` |
| **HTTP inside the monolith** | `fetch('http://localhost:3000/api/wallet/reserve')` | `await billingTools.reserveCredits(...)` |
| **Passing Express objects** | `billingTools.reserve(req, res)` | `billingTools.reserveCredits({ userId: req.user.id, amount })` |
| **Internal importing barrel** | `catalog.js` imports from `../public/tools.js` | `catalog.js` imports from sibling `./schema.js` inside `internal/` |
| **Hardcoded feature switch** | Giant `if (model === 'x') ... else if (model === 'y')` in orchestrator | `modelsTools.execute({ modelId, input })` using an internal Registry |

---

## 5. Automated Architecture Checker (`arch-check`) Rules

Any static analysis script (`scripts/arch-check.cjs`) run in CI and `.githooks/pre-commit` must enforce:
1. **No `internal/` Leaks:** Fail if any file in `src/systems/<A>/` or `src/app.js` imports a path containing `/systems/<B>/internal/` where `<A> !== <B>`.
2. **No DB Client Leaks:** Fail if `supabase`, `prisma`, `pg`, or `mongoose` is imported outside `*/internal/db/*`.
3. **No Express in `tools.js` or `internal/services/`:** Fail if `express` is imported outside `src/app.js` and `*/public/api.js`.
4. **No Circular Dependencies:** Run a directed-graph cycle detector across all files and across all systems; fail on any cycle.
5. **Ratchet Legacy Exceptions:** If migrating an existing codebase, store existing violations in an `arch-exceptions.json` baseline file and fail CI if the violation count ever increases.

---

## 6. Agent Pre-Flight Checklist (Mandatory Before Every Task)

Before creating or editing any code in this repository, the coding agent must verify:
- [ ] **System Ownership:** Which Business System owns this feature and its database tables?
- [ ] **Gateway Placement:** Are HTTP routes placed in `public/api.js` and cross-system functions in `public/tools.js`?
- [ ] **Boundary Safety:** Am I importing other systems exclusively via `#<system>/tools`?
- [ ] **DTO Purity:** Are all inputs/outputs of `public/tools.js` plain JSON-serializable objects?
- [ ] **Rollback Safety:** Does every credit/quota reservation have a `try/catch` rollback and worker settlement path?
- [ ] **Verification:** Did I run the architecture boundary checker (`arch-check`) and tests after my edits?
