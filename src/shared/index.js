/**
 * Shared Technical Kernel Entrypoint (#shared).
 *
 * Encapsulates purely technical, non-domain cross-cutting capabilities (zero Redis / DB clients):
 * - Errors: AppError, ProviderError, ValidationError, BillingError, SystemError, CrudServiceError, safePublicRouteError, ErrorSystem, scrubSensitiveText, sanitizePublicError
 * - Logger: createLogger, runWithContext, setContext, getContext, LogEvents, LogErrorCodes, requestLogger, wrapWorkerJob
 * - Config: envConfig, loggingConfig, RATE_LIMIT_POLICIES
 * - Utils: ratioUtils, concurrency, pathUtils, templateUtils, mediaTypeUtils
 *
 * Redis clients live on the explicit `#shared/redis` subpath so non-queue consumers
 * (such as `#workflow-engine/tools`) never load `ioredis` or open TCP sockets.
 */

export * from "./errors/index.js";
export * from "./logger/index.js";
export * from "./logger/middleware.js";
export * from "./config/index.js";
export * from "./utils/index.js";

