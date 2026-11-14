# Ticket 1.2: Structured Logging & Tracing Infrastructure (`src/shared/logger/`)

## 1. Description & Context
Consolidate the application's structured logging and request tracing system under `src/shared/logger/`.

## 2. Inviolable Requirements
1. **Modules**:
   - `src/shared/logger/context.js`: AsyncLocalStorage store providing `runWithContext`, `setContext`, `getContext`, `getCleanContext`.
   - `src/shared/logger/baseLogger.js`: Pino instance configured with ISO timestamp and redaction.
   - `src/shared/logger/redaction.js`: Masking for passwords, authorization headers, API keys, and sensitive tokens.
   - `src/shared/logger/serializers.js`: Standardized serializers for Express requests, responses, and errors.
   - `src/shared/logger/events.js`: Central `LogEvents` catalog.
   - `src/shared/logger/errors.js`: `LogErrorCodes` enumeration.
   - `src/shared/logger/middleware.js`: Express `requestLogger` and `workerLogger` helper.
   - `src/shared/logger/index.js`: `createLogger(moduleName)`, scoped logging with automated context injection, fail-safe error handling.
2. **Zero Domain / Database Logic**:
   - Must not import any models, repositories, or Supabase.
3. **Zero Breaking Changes**:
   - Legacy `src/infrastructure/logging/` and `src/runtime/logger.js` re-export from `src/shared/logger/`.

## 3. Test Coverage
- `tests/unit/sharedLogger.test.js` validating logger output, level formatting, AsyncLocalStorage context injection, and child logger creation.
