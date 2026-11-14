# Ticket 1.1: Base Error Hierarchy & Runtime Error Processor (`src/shared/errors/`)

## 1. Description & Context
Create `src/shared/errors/` containing the unified `AppError` class, specialized error subclasses (`ProviderError`, `ValidationError`, `BillingError`, `SystemError`, `InsufficientCreditsError`, `ReservationExpiredError`), `CrudServiceError`, `safePublicRouteError`, and `ErrorSystem`.

## 2. Inviolable Requirements
1. **Hybrid AppError Constructor**:
   - Signature 1 (legacy 2-arg): `new AppError(message, statusCode)` -> sets `message`, `statusCode`, `isOperational = true`, `status = "fail"|"error"`, `code = "APP_ERROR"`.
   - Signature 2 (rich 3-arg): `new AppError(code, message, options)` -> sets `code`, `message`, `statusCode` (default 500), `type`, `category`, `retryable`, `billingAction`, `context`, etc.
2. **Specialized Subclasses**:
   - `ProviderError`, `ValidationError`, `BillingError`, `SystemError`, `InsufficientCreditsError`, `ReservationExpiredError`, `CrudServiceError`.
3. **Pure Route Sanitization**:
   - `safePublicRouteError(err, { statusCode } = {})` must mask 5xx errors to `Internal server error` and preserve 4xx client contracts.
4. **Runtime Error Processing**:
   - `ErrorSystem.process(err, context)` formats error reports and logs via structured logger without domain dependencies.
5. **Zero Breaking Changes**:
   - Re-export in legacy paths `src/errors/AppError.js`, `src/utils/AppError.js`, `src/utils/safePublicRouteError.js`, `src/runtime/ErrorSystem.js`, and `src/utils/crudOperationLog.js`.

## 3. Test Coverage
- `tests/unit/sharedErrors.test.js` verifying all constructor signatures, inheritance chains, `safePublicRouteError`, and `ErrorSystem.process`.
