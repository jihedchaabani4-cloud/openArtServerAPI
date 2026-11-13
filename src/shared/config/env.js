export const envConfig = {
  get env() { return process.env.NODE_ENV || "development"; },
  get isProduction() { return (process.env.NODE_ENV || "development") === "production"; },
  get isTest() { return (process.env.NODE_ENV || "development") === "test"; },
  get isDevelopment() { return !this.isProduction && !this.isTest; },
  get level() { return process.env.LOG_LEVEL || (this.isProduction ? "info" : "debug"); },
  get prettyPrint() { return this.isDevelopment || process.env.LOG_PRETTY === "true"; },
  get frontendUrl() { return process.env.FRONTEND_URL || ""; },
  get baseUrl() { return process.env.BASE_URL || ""; },
};

export const redisConfig = {
  url: process.env.REDIS_URL || process.env.REDIS_DEV_URL || "",
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || "",
  rateLimitCommandTimeoutMs: Number(process.env.RATE_LIMIT_COMMAND_TIMEOUT_MS) || 1500,
  get isTestEnv() { return envConfig.isTest; },
};

export default envConfig;
