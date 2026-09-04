/**
 * Centralized logging configuration.
 */

const env = process.env.NODE_ENV || "development";
const isProduction = env === "production";
const isTest = env === "test";
const isDevelopment = !isProduction && !isTest;

export const loggingConfig = {
  env,
  isProduction,
  isTest,
  isDevelopment,
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  prettyPrint: isDevelopment || process.env.LOG_PRETTY === "true",
};

export default loggingConfig;
