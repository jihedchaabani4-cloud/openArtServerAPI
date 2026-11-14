# Ticket 1.3: Pure Technical Config & Redis Connection Kernel (`src/shared/config/`, `src/shared/redis/`, `#shared`)

## 1. Description & Context
Create `src/shared/config/` for pure runtime environment flags, `src/shared/redis/` for resilient Upstash and BullMQ Redis connection pooling, and the root `src/shared/index.js` aggregating the entire Shared Technical Kernel. Configure `package.json#imports` with `#shared`.

## 2. Inviolable Requirements
1. **Config (`src/shared/config/`)**:
   - `env.js` and `index.js` exporting `env`, `isProduction`, `isTest`, `isDevelopment`, `logLevel`, `prettyPrint`.
   - Must contain zero business configuration (no character limits, no generation rules).
2. **Redis (`src/shared/redis/`)**:
   - `client.js` and `index.js` exporting `redisConnection`, `workerRedisConnection`, `rateLimitRedisConnection`, `isRedisReady`, `closeRedisConnections`.
   - Preserves Upstash TLS options, smooth exponential backoff (`retryStrategy`), and fail-fast rate-limiting configuration.
3. **Shared Index (`src/shared/index.js`)**:
   - Re-exports `{ createLogger, runWithContext, AppError, safePublicRouteError, redisConnection, config }`.
4. **Package.json Subpath Imports**:
   - Register `#shared` -> `./src/shared/index.js`
   - Register `#shared/*` -> `./src/shared/*`
5. **Zero Breaking Changes**:
   - `src/queue/redis.js` and `src/infrastructure/logging/config.js` re-export from `src/shared/`.

## 3. Test Coverage
- `tests/unit/sharedRedisAndConfig.test.js` validating config flags, Redis exports, and `#shared` module resolution.
