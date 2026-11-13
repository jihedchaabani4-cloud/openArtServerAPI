/**
 * Legacy Re-export for Redis connections.
 * Canonical implementation now lives in src/shared/redis/
 */
export {
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRateLimitRedis,
  RECONCILIATION_CACHE_KEY,
} from "../shared/redis/index.js";

import redisModule from "../shared/redis/index.js";
export default redisModule;
