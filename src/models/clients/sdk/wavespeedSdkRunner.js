import { Client as WavespeedClient } from "wavespeed";
import { ProviderRequestError, ProviderTransientError } from "../../errors/index.js";

/**
 * Official WaveSpeed SDK Runner
 * Interfaces with WaveSpeed AI models via the official wavespeed npm package.
 * Docs: https://wavespeed.ai/docs/javascript-sdk
 */
export async function runWaveSpeedSdk({
  binding,
  payload,
  credential,
  options = {},
}) {
  const providerModelId = binding.providerModelId;
  const apiKey = credential || process.env.WAVESPEED_API_KEY || null;

  const pollingConfig = binding?.pollingConfig || {};
  const pollInterval = options.pollInterval ?? pollingConfig.pollInterval ?? 2.0;
  const timeout = options.timeout ?? pollingConfig.timeout ?? 3600;

  // Allow injected client for testing/mocking
  const client =
    options.sdkClient ||
    new WavespeedClient(apiKey, {
      timeout,
      pollInterval,
      maxRetries: options.maxRetries ?? 0,
      maxConnectionRetries: options.maxConnectionRetries ?? 3,
    });

  const runConfig = {
    pollInterval,
    timeout,
    enableSyncMode: options.enableSyncMode || false,
  };

  try {
    const result = await client.run(providerModelId, payload, runConfig);

    // Standardize result structure for downstream parameterMapper
    if (result && typeof result === "object") {
      if (Array.isArray(result.outputs)) {
        return result;
      }
      if (Array.isArray(result)) {
        return { outputs: result };
      }
      if (result.output) {
        return { outputs: Array.isArray(result.output) ? result.output : [result.output], ...result };
      }
      return { outputs: [result], ...result };
    }

    return { outputs: [result] };
  } catch (err) {
    const errMsg = err.message || "WaveSpeed SDK execution error";

    // Handle WaveSpeed specific exception types
    if (err.name === "WavespeedTimeoutException" || err.name === "WavespeedSyncTimeoutException") {
      const timeoutErr = new ProviderTransientError(`WaveSpeed task timed out: ${errMsg}`);
      timeoutErr.statusCode = 504;
      timeoutErr.code = "PROVIDER_TIMEOUT";
      timeoutErr.raw = err;
      throw timeoutErr;
    }

    if (err.name === "WavespeedConnectionException") {
      const netErr = new ProviderTransientError(`WaveSpeed connection error: ${errMsg}`);
      netErr.statusCode = 502;
      netErr.code = "PROVIDER_UNAVAILABLE";
      netErr.raw = err;
      throw netErr;
    }

    if (err.name === "WavespeedPredictionException" || err.name === "WavespeedSubmissionException") {
      const reqErr = new ProviderRequestError(`WaveSpeed rejected request: ${errMsg}`);
      reqErr.statusCode = 400;
      reqErr.code = "INVALID_INPUT_REJECTED_BY_PROVIDER";
      reqErr.raw = err;
      throw reqErr;
    }

    // Generic error fallback
    const providerErr = new ProviderRequestError(errMsg);
    providerErr.statusCode = err.status || err.statusCode || 500;
    providerErr.raw = err;
    throw providerErr;
  }
}
