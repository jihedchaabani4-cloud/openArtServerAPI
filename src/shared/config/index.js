/**
 * Shared Config Entrypoint.
 */
import {
  envConfig,
  redisConfig,
  clampBulkDeleteConcurrency,
  BULK_DELETE_CONCURRENCY_DEFAULT,
  BULK_DELETE_CONCURRENCY_MIN,
  BULK_DELETE_CONCURRENCY_MAX,
} from "./env.js";
import { RATE_LIMIT_POLICIES, DEFAULT_MAX_CONCURRENT_UPLOADS } from "./rateLimitPolicies.js";

export {
  envConfig,
  redisConfig,
  clampBulkDeleteConcurrency,
  BULK_DELETE_CONCURRENCY_DEFAULT,
  BULK_DELETE_CONCURRENCY_MIN,
  BULK_DELETE_CONCURRENCY_MAX,
  RATE_LIMIT_POLICIES,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
};
export const loggingConfig = envConfig;
export default envConfig;
