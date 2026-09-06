import { executeProvider } from "../runtime/providerRuntimeRegistry.js";
import { readSseStream } from "../runtime/sseStreamReader.js";
import { normalizeError } from "./errorNormalizer.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Runtime Executor
 *
 * Handles external provider invocation, retry loop with exponential backoff
 * for retryable errors, and SSE streaming coordination.
 */
export class RuntimeExecutor {
  /**
   * Executes provider invocation with resilient retry-with-backoff loop.
   *
   * @param {object} params
   * @param {object} params.provider
   * @param {object} params.binding
   * @param {object} params.providerPayload
   * @param {string|null} params.credential
   * @param {string} params.modelId
   * @param {string} params.operation
   * @param {string} params.bindingId
   * @param {object} [params.options]
   * @returns {Promise<any>} rawResponse from provider
   */
  async execute({
    provider,
    binding,
    providerPayload,
    credential,
    modelId,
    operation,
    bindingId,
    options = {},
  }) {
    const maxRetries = options.maxRetries ?? 2;
    const initialBackoffMs = options.initialBackoffMs ?? 150;
    const isStreaming = Boolean(binding.streaming && options.onStreamChunk);
    const attemptsTotal = isStreaming ? 1 : maxRetries + 1;

    let rawResponse;
    let lastErr = null;

    for (let attempt = 1; attempt <= attemptsTotal; attempt++) {
      try {
        if (isStreaming) {
          const streamReader = options.streamReader || readSseStream;
          rawResponse = await streamReader({
            provider,
            binding,
            payload: providerPayload,
            credential,
            onChunk: options.onStreamChunk,
          });
        } else {
          rawResponse = await executeProvider({
            provider,
            binding,
            payload: providerPayload,
            credential,
            timeoutMs: options.timeoutMs,
            options,
          });
        }
        lastErr = null;
        return rawResponse;
      } catch (err) {
        lastErr = err;
        const normalized = normalizeError(err, { binding, provider });
        if (normalized.retryable && attempt < attemptsTotal) {
          const maxBackoffMs = options.maxBackoffMs ?? 2000;
          const randomFn = options.randomFn || Math.random;
          const expCeiling = Math.min(maxBackoffMs, initialBackoffMs * Math.pow(2, attempt - 1));
          const backoffMs = Math.max(1, Math.round(randomFn() * expCeiling));
          logger.warn(
            {
              modelId,
              operation,
              bindingId,
              attempt,
              nextAttemptInMs: backoffMs,
              error: normalized.message,
            },
            `[RuntimeExecutor] Retryable provider error on attempt ${attempt}/${attemptsTotal}. Backing off with jitter for ${backoffMs}ms...`
          );
          const sleeper = options.sleeper || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
          await sleeper(backoffMs);
          continue;
        }
        throw lastErr;
      }
    }

    if (lastErr) {
      throw lastErr;
    }

    return rawResponse;
  }
}

export const defaultRuntimeExecutor = new RuntimeExecutor();
