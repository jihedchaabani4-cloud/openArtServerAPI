/**
 * Shared Config Entrypoint.
 */
import { envConfig, redisConfig } from "./env.js";

export { envConfig, redisConfig };
export const loggingConfig = envConfig;
export default envConfig;
