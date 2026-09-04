import {
  Client as WaveSpeedSDKClient,
  WavespeedTimeoutException,
  WavespeedSyncTimeoutException,
  WavespeedConnectionException,
  WavespeedPredictionException,
  WavespeedSubmissionException,
} from "wavespeed";
import {
  ProviderRequestError,
  ProviderTransientError,
  ProviderContentPolicyError,
} from "../../models/errors/index.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const providerLogger = createLogger("provider");

export class WaveSpeedClient {
  constructor({ baseUrl = "https://api.wavespeed.ai", apiKey, credential, timeoutMs = 300000 } = {}) {
    const cleanBaseUrl = (baseUrl || "https://api.wavespeed.ai").replace(/\/api\/v3\/?$/, "").replace(/\/+$/, "");
    this.baseUrl = cleanBaseUrl;
    this.apiKey = credential?.apiKey || apiKey || "";
    this.timeoutMs = timeoutMs;
    this.client = new WaveSpeedSDKClient(this.apiKey, {
      baseUrl: this.baseUrl,
      connectionTimeout: 120,
      timeout: Math.floor(this.timeoutMs / 1000),
    });
  }

  async execute(options, legacyPayload) {
    let endpoint, payload, providerModelId, operation, executionConfig;

    if (typeof options === "string") {
      endpoint = options;
      payload = legacyPayload;
      executionConfig = { endpoint };
    } else {
      payload = options.payload;
      providerModelId = options.providerModelId;
      operation = options.operation;
      executionConfig = options.executionConfig || {};
      endpoint = executionConfig.endpoint || (typeof options.endpoint === "string" ? options.endpoint : "");
    }

    // Mock for test environments
    if (process.env.NODE_ENV === "test") {
      const promptVal = payload?.prompt || payload?.body?.prompt;
      if (options.simulateError || executionConfig?.simulateError || promptVal === "__SIMULATE_FAILURE__") {
        throw new ProviderRequestError("Simulated WaveSpeed provider outage");
      }
      if (!this.apiKey?.startsWith("real_") && !this.apiKey?.startsWith("ws_")) {
        return {
          id: "mock-task-12345",
          status: "completed",
          outputs: [`https://cdn.openart.ai/generated/${Date.now()}.png`],
          output: { url: `https://cdn.openart.ai/generated/${Date.now()}.png` },
        };
      }
    }

    const modelId = providerModelId || endpoint.replace(/^\//, "");
    const startTime = performance.now();

    providerLogger.debug(
      {
        provider: "wavespeed",
        modelId,
        event: LogEvents.PROVIDER_REQUEST_STARTED,
      },
      `WaveSpeed request started for ${modelId}`
    );

    let attempts = 0;
    const maxRetries = 2;

    while (attempts <= maxRetries) {
      try {
        const requestBody = (payload && typeof payload === "object" && payload.body && typeof payload.body === "object") ? payload.body : payload;
        const result = await this.client.run(modelId, requestBody, {
          timeout: Math.floor(this.timeoutMs / 1000),
          pollInterval: 2.0,
          enableSyncMode: false,
        });

        const durationMs = Math.round(performance.now() - startTime);
        providerLogger.info(
          {
            provider: "wavespeed",
            modelId,
            durationMs,
            attempts,
            event: LogEvents.PROVIDER_REQUEST_COMPLETED,
          },
          `WaveSpeed request for ${modelId} completed in ${durationMs}ms`
        );

        return result;
      } catch (err) {
        attempts++;
        const msg = err.message || String(err);
        const isTransient =
          err instanceof WavespeedTimeoutException ||
          err instanceof WavespeedSyncTimeoutException ||
          err instanceof WavespeedConnectionException ||
          msg.includes("429") ||
          msg.includes("502") ||
          msg.includes("503");

        if (isTransient && attempts <= maxRetries) {
          const delayMs = attempts * 1000;
          providerLogger.warn(
            { provider: "wavespeed", modelId, attempt: attempts, delayMs },
            `WaveSpeed transient error. Retrying in ${delayMs}ms...`
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        const durationMs = Math.round(performance.now() - startTime);
        providerLogger.error(
          {
            provider: "wavespeed",
            modelId,
            durationMs,
            attempts,
            err,
            event: LogEvents.PROVIDER_REQUEST_FAILED,
          },
          `WaveSpeed request for ${modelId} failed in ${durationMs}ms: ${msg}`
        );

        if (err instanceof WavespeedTimeoutException || err instanceof WavespeedSyncTimeoutException) {
          throw new ProviderTransientError(`WaveSpeed task timed out: ${msg}`);
        }
        if (err instanceof WavespeedConnectionException) {
          throw new ProviderTransientError(`WaveSpeed connection error: ${msg}`);
        }
        if (err instanceof WavespeedPredictionException) {
          if (msg.includes("NSFW") || msg.includes("policy") || msg.includes("moderation")) {
            throw new ProviderContentPolicyError(`WaveSpeed content moderation: ${msg}`);
          }
          throw new ProviderRequestError(`WaveSpeed prediction failed: ${msg}`);
        }
        if (err instanceof WavespeedSubmissionException) {
          if (msg.toLowerCase().includes("insufficient credits") || msg.includes("HTTP 400")) {
            const quotaErr = new ProviderRequestError(`WaveSpeed submission failed: ${msg}`);
            quotaErr.code = "PROVIDER_QUOTA_EXCEEDED";
            quotaErr.retryable = false;
            throw quotaErr;
          }
          throw new ProviderRequestError(`WaveSpeed submission failed: ${msg}`);
        }
        throw new ProviderRequestError(`WaveSpeed error: ${msg}`);
      }
    }
  }
}
