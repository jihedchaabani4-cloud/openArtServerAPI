# Design Document — Partie 01: Shared Technical Kernel (`src/shared/`)

> **Architectural Standard**: Modular Monolith Constitution (`01_business_systems_architecture.md`, `02_architecture_rules_and_agent_guardrails.md`)  
> **Status**: APPROVED  
> **Target Directory**: `src/shared/`

---

## 1. Executive Summary & Objective

In a strict Modular Monolith, domain systems (`src/systems/<name>/`) must never import low-level infrastructure directly from disparate ad-hoc folders or from other domain systems. Instead, pure cross-cutting technical primitives live in a unified **Shared Technical Kernel** (`src/shared/`).

The Shared Technical Kernel provides:
1. **Base Error Hierarchy (`src/shared/errors/`)**: Unified `AppError` supporting both legacy `(message, statusCode)` and modern `(code, message, options)` signatures, specialized subclasses (`ProviderError`, `ValidationError`, `BillingError`, `SystemError`, `CrudServiceError`), error mapping (`safePublicRouteError`), and runtime processing (`ErrorSystem`).
2. **Structured Logging & Tracing (`src/shared/logger/`)**: High-performance Pino logger with AsyncLocalStorage request/trace/job context propagation (`createLogger`, `runWithContext`, `getContext`, `setContext`), redaction of sensitive credentials, standardized serializers, and Express/worker middlewares.
3. **Pure Technical Config (`src/shared/config/`)**: Environment mode flags (`isProduction`, `isTest`, `isDevelopment`, `level`, `prettyPrint`). Zero business rules.
4. **Resilient Redis Kernel (`src/shared/redis/`)**: Upstash/BullMQ-optimized connection singletons (`redisConnection`, `workerRedisConnection`, `rateLimitRedisConnection`) with automatic reconnect backoff and fail-fast rate-limiting.

---

## 2. Inviolable Boundary & Purity Rules

1. **Zero Domain Logic**: `src/shared/` must never contain concepts like Characters, Elements, Prompts, Workflows, Generation, or Wallets.
2. **Zero Database / ORM Imports**: `src/shared/` must NEVER import `supabase`, `supabaseAdmin`, Prisma, or any file from repositories.
3. **Zero Imports from Systems**: `src/shared/` must NEVER import from `src/systems/`, `#systems/*`, or domain directories.
4. **100% Backward Compatibility**: Existing imports from `src/infrastructure/logging/`, `src/errors/`, `src/utils/AppError.js`, `src/utils/crudOperationLog.js`, and `src/queue/redis.js` continue working via transparent re-exports until Partie 10.

---

## 3. Directory Layout

```text
src/shared/
├── index.js                  # Root aggregator (#shared)
├── errors/
│   ├── index.js              # Exports AppError, ProviderError, ValidationError, BillingError, etc.
│   ├── AppError.js           # Hybrid backward-compatible base AppError class
│   ├── CrudServiceError.js   # Standard CRUD error
│   ├── safePublicRouteError.js # Route error sanitizer
│   └── ErrorSystem.js        # Error processing & reporting system
├── logger/
│   ├── index.js              # Main logging entrypoint (createLogger, runWithContext, etc.)
│   ├── baseLogger.js         # Core Pino logger instance
│   ├── context.js            # AsyncLocalStorage trace context
│   ├── redaction.js          # Sensitive payload key redactor
│   ├── serializers.js        # HTTP req/res/err serializers
│   ├── events.js             # LogEvents enumeration
│   ├── errors.js             # LogErrorCodes enumeration
│   └── middleware.js         # requestLogger & workerLogger helpers
├── config/
│   ├── index.js              # Environment & logging config
│   └── env.js                # NODE_ENV parsing & flags
└── redis/
    ├── index.js              # Redis connection pool exports & lifecycle
    └── client.js             # Redis client initialization & reconnect strategy
```

---

## 4. Tickets Breakdown

- **Ticket 1.1: Base Error Hierarchy & Runtime Error Processor (`src/shared/errors/`)**
  - Implement `AppError` (hybrid constructor supporting both `(message, statusCode)` and `(code, message, options)`), specialized subclasses, `CrudServiceError`, `safePublicRouteError`, and `ErrorSystem`.
  - Re-export in legacy locations: `src/errors/AppError.js`, `src/utils/AppError.js`, `src/utils/safePublicRouteError.js`, `src/runtime/ErrorSystem.js`.
  - Unit test: `tests/unit/sharedErrors.test.js`.

- **Ticket 1.2: Structured Logging & Tracing Infrastructure (`src/shared/logger/`)**
  - Consolidate `createLogger`, `runWithContext`, `setContext`, `getContext`, `getCleanContext`, `LogEvents`, `LogErrorCodes`, `baseLogger`, `redaction`, `serializers`, `requestLogger`, `workerLogger`.
  - Re-export in legacy `src/infrastructure/logging/` and `src/runtime/logger.js`.
  - Unit test: `tests/unit/sharedLogger.test.js`.

- **Ticket 1.3: Pure Technical Config & Redis Connection Kernel (`src/shared/config/`, `src/shared/redis/`, `#shared`)**
  - Consolidate pure environment config (`src/shared/config/`) and Redis client singletons (`src/shared/redis/`).
  - Create root `src/shared/index.js`.
  - Update `package.json#imports` with `#shared` and `#shared/*`.
  - Re-export in `src/queue/redis.js` and `src/infrastructure/logging/config.js`.
  - Unit test: `tests/unit/sharedRedisAndConfig.test.js`.
