/**
 * Shared Config Entrypoint.
 */
import { envConfig, redisConfig } from "./env.js";
import { RATE_LIMIT_POLICIES, DEFAULT_MAX_CONCURRENT_UPLOADS } from "./rateLimitPolicies.js";

export { envConfig, redisConfig, RATE_LIMIT_POLICIES, DEFAULT_MAX_CONCURRENT_UPLOADS };
export const loggingConfig = envConfig;
export default envConfig;
