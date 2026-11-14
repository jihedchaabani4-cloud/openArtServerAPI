/**
 * Shared Technical Kernel Entrypoint (#shared).
 *
 * Encapsulates purely technical, non-domain cross-cutting capabilities:
 * - Errors: AppError, ProviderError, ValidationError, BillingError, SystemError, CrudServiceError, safePublicRouteError, ErrorSystem
 * - Logger: createLogger, runWithContext, setContext, getContext, LogEvents, LogErrorCodes, requestLogger, wrapWorkerJob
 * - Config: envConfig, loggingConfig
 * - Redis: redisConnection, workerRedisConnection, rateLimitRedisConnection, waitForRateLimitRedis
 */

export * from "./errors/index.js";
export * from "./logger/index.js";
export * from "./config/index.js";
export * from "./redis/index.js";
export * from "./utils/index.js";

