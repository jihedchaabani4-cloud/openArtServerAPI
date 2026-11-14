export const envConfig = {
  get env() { return process.env.NODE_ENV || "development"; },
  get isProduction() { return (process.env.NODE_ENV || "development") === "production"; },
  get isTest() { return (process.env.NODE_ENV || "development") === "test"; },
  get isDevelopment() { return !this.isProduction && !this.isTest; },
  get level() { return process.env.LOG_LEVEL || (this.isProduction ? "info" : "debug"); },
  get prettyPrint() { return this.isDevelopment || process.env.LOG_PRETTY === "true"; },
  get frontendUrl() { return process.env.FRONTEND_URL || ""; },
  get baseUrl() { return process.env.BASE_URL || ""; },
  get initialWalletBalance() {
    return Number(process.env.INITIAL_WALLET_BALANCE || process.env.DEFAULT_WALLET_BALANCE || 0);
  },
  get devAuthBypass() {
    return (process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) && !this.isProduction;
  },
  get folderMaxDepth() {
    return Number(process.env.FOLDER_MAX_DEPTH || 3);
  },
  get folderMaxPerProject() {
    return Number(process.env.FOLDER_MAX_PER_PROJECT || 50);
  },
  get elementMaxMedia() {
    const raw = process.env.ELEMENT_MAX_MEDIA || process.env.ELEMENT_MAX_REFERENCE_MEDIA;
    if (raw !== undefined && raw !== null && raw !== "") {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 6;
  },
  get characterMaxDetailMedia() {
    return Number(process.env.CHARACTER_MAX_DETAIL_MEDIA) || 5;
  },
  get maxConcurrentUploadsPerUser() {
    return Number(process.env.MAX_CONCURRENT_UPLOADS_PER_USER) || 0;
  },
  get maxInFlightUploadBytes() {
    return Number(process.env.MAX_IN_FLIGHT_UPLOAD_BYTES) || 0;
  },
  get creditToUsdRate() {
    return process.env.CREDIT_TO_USD_RATE;
  },
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
  },
  get wavespeedApiKey() {
    return process.env.WAVESPEED_API_KEY || null;
  },
  get assetListMaxLimit() {
    return Number(process.env.ASSET_LIST_MAX_LIMIT || 200);
  },
  get enableV2WorkflowRunEndpoint() {
    return process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT === "true";
  },
  getEnvVar(key) {
    return process.env[key];
  },
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
