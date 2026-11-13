/**
 * Centralized pure environment configuration.
 * Zero business rules, zero database calls.
 */

const env = process.env.NODE_ENV || "development";
const isProduction = env === "production";
const isTest = env === "test";
const isDevelopment = !isProduction && !isTest;

export const envConfig = {
  env,
  isProduction,
  isTest,
  isDevelopment,
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  prettyPrint: isDevelopment || process.env.LOG_PRETTY === "true",
};

export const redisConfig = {
  url: process.env.REDIS_URL || process.env.REDIS_DEV_URL || "",
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || "",
  rateLimitCommandTimeoutMs: Number(process.env.RATE_LIMIT_COMMAND_TIMEOUT_MS) || 1500,
  isTestEnv: isTest,
};

export default envConfig;
