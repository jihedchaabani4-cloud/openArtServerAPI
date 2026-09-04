import { getModel, getProvider } from "../registry/modelRegistry.js";
import { validateCanonicalInput } from "../registry/schemaValidator.js";
import { selectBinding } from "../registry/bindingSelector.js";
import { mapToProviderPayload, mapFromProviderResponse } from "../registry/parameterMapper.js";
import { calculateRetailCredits, calculateWholesaleCostUsd, calculateMargin } from "./pricingCalculator.js";
import { circuitBreakerRegistry } from "./circuitBreaker.js";
import { normalizeError } from "./errorNormalizer.js";
import { executeProviderSdk } from "../clients/sdk/providerSdkDispatcher.js";
import { readSseStream } from "../clients/sseStreamReader.js";
import { getCustomAdapter } from "../clients/customAdapterRunner.js";
import { resolveCredential } from "../credentials/credentialResolver.js";
import { walletService as defaultWalletService } from "../../services/walletService.js";
import { idempotencyStore as defaultIdempotencyStore } from "./idempotencyStore.js";
import { MissingUserIdError } from "../errors/index.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Universal Model Runner
 * Coordinates validation, pricing, two-phase wallet holds, binding routing,
 * payload translation, execution, circuit breaker tracking, and telemetry.
 */
export async function run(modelId, operation, rawInput = {}, options = {}) {
  const startTime = Date.now();
  const generationId = options.generationId || `gen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const userId = options.userId || null;
  const noCharge = Boolean(options.noCharge);
  const noChargeReason = options.reason || options.noChargeReason || null;
  const skipWalletHold = Boolean(options.skipWalletHold);
  const walletService = options.walletService || defaultWalletService;

  // 1. Enforce userId requirement (Task 2)
  if (!userId && !noCharge) {
    throw new MissingUserIdError("userId is required for model execution unless noCharge is explicitly granted");
  }

  if (noCharge) {
    logger.info(
      {
        event: "models.execution.no_charge",
        modelId,
        operation,
        reason: noChargeReason || "unspecified",
        caller: options.caller || "unknown",
      },
      `Model execution permitted without charge (reason: "${noChargeReason || 'unspecified'}") for ${modelId} (${operation})`
    );
  }

  // 2. Resolve Model
  const model = options.model || getModel(modelId);
  const opDef = model.operations?.[operation];
  if (!opDef) {
    throw new Error(`Operation "${operation}" not supported for model "${modelId}"`);
  }

  // 3. Validate Canonical Input
  const cleanInput = validateCanonicalInput(opDef.canonicalInputs || {}, rawInput, {
    allowUnknown: options.allowUnknown || false,
  });

  // 4. Idempotency Check (Task 5) — return early before any wallet hold or provider call
  const idempotencyKey = options.idempotencyKey || rawInput.idempotencyKey || null;
  const store = options.idempotencyStore || defaultIdempotencyStore;
  if (idempotencyKey && store) {
    const cachedResult = await store.get(idempotencyKey);
    if (cachedResult) {
      logger.info(
        {
          event: "models.execution.idempotency_hit",
          idempotencyKey,
          modelId,
          operation,
        },
        `Idempotency cache hit for key "${idempotencyKey}". Returning cached execution result without re-billing.`
      );
      return cachedResult;
    }
  }

  // 5. Evaluate Fixed Retail Pricing
  const creditsRequired = calculateRetailCredits(model, operation, cleanInput);

  // 6. Two-Phase Wallet Hold (Reservation) — supports skipWalletHold (Task 6)
  let reservation = null;
  if (!noCharge && !skipWalletHold && userId && walletService && creditsRequired > 0) {
    reservation = await walletService.reserve({
      userId,
      amount: creditsRequired,
      model: modelId,
      operation,
      pricingVersion: "fixed_retail",
      referenceId: `res_${generationId}`,
    });
    logger.info(
      { event: LogEvents.WALLET_HOLD_CREATED, userId, amount: creditsRequired, generationId },
      `Held ${creditsRequired} credits for ${modelId} (${operation})`
    );
  }

  // 7. Two-Phase Binding Selection (Capability ➔ Health ➔ Priority)
  const binding = selectBinding(modelId, operation, cleanInput, {
    ...options,
    model,
  });
  const provider = getProvider(binding.providerId);
  const bindingId = `${binding.modelId}:${binding.operation}:${binding.providerId}`;

  // 8. Wholesale Margin Evaluation
  const wholesaleCostUsd = calculateWholesaleCostUsd(binding, cleanInput);
  const margin = calculateMargin(creditsRequired, wholesaleCostUsd);

  // 9. Resolve Credential (secure BYOK with userId)
  let credential = null;
  try {
    const credResult = await resolveCredential(
      binding,
      provider,
      options.credentialProvider,
      options.dbClient,
      { userId }
    );
    credential = credResult?.apiKey || null;
  } catch (err) {
    credential = options.credential || null;
    if (!credential && provider.authType !== "none") {
      // Allow provider/SDK to throw on execution if required
    }
  }

  // 10. Transform to Provider Payload
  let providerPayload;
  let customAdapter = null;
  if (binding.customAdapter) {
    customAdapter = await getCustomAdapter(binding.customAdapter);
    if (customAdapter && typeof customAdapter.toProviderPayload === "function") {
      providerPayload = customAdapter.toProviderPayload(cleanInput, binding);
    } else {
      providerPayload = mapToProviderPayload(cleanInput, binding);
    }
  } else {
    providerPayload = mapToProviderPayload(cleanInput, binding);
  }

  // 11. Execute External Provider with Retry-with-Backoff (Task 9)
  let rawResponse;
  const maxRetries = options.maxRetries ?? 2;
  const initialBackoffMs = options.initialBackoffMs ?? 150;
  const attemptsTotal = (binding.streaming && options.onStreamChunk) ? 1 : (maxRetries + 1);

  let lastErr = null;
  for (let attempt = 1; attempt <= attemptsTotal; attempt++) {
    try {
      if (binding.streaming && options.onStreamChunk) {
        const streamReader = options.streamReader || readSseStream;
        rawResponse = await streamReader({
          provider,
          binding,
          payload: providerPayload,
          credential,
          onChunk: options.onStreamChunk,
        });
      } else {
        rawResponse = await executeProviderSdk({
          provider,
          binding,
          payload: providerPayload,
          credential,
          timeoutMs: options.timeoutMs,
          options,
        });
      }
      lastErr = null;
      break; // Success!
    } catch (err) {
      lastErr = err;
      const normalized = normalizeError(err, { binding, provider });
      if (normalized.retryable && attempt < attemptsTotal) {
        const backoffMs = initialBackoffMs * Math.pow(2, attempt - 1);
        logger.warn(
          {
            modelId,
            operation,
            bindingId,
            attempt,
            nextAttemptInMs: backoffMs,
            error: normalized.message,
          },
          `[ModelRunner] Retryable provider error on attempt ${attempt}/${attemptsTotal}. Backing off for ${backoffMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      break;
    }
  }

  try {
    if (lastErr) {
      throw lastErr;
    }

    // Circuit Breaker Success
    circuitBreakerRegistry.recordSuccess(bindingId);

    // Commit Wallet Hold
    if (reservation && walletService) {
      await walletService.commit(reservation.reservationId, {
        creditsCharged: creditsRequired,
        generationId,
      });
    }

    // Normalize Output
    let normalizedOutput;
    if (customAdapter && typeof customAdapter.fromProviderResponse === "function") {
      normalizedOutput = customAdapter.fromProviderResponse(rawResponse, binding);
    } else {
      normalizedOutput = mapFromProviderResponse(rawResponse, binding);
    }

    const durationMs = Date.now() - startTime;

    // Emit Success Telemetry
    logger.info(
      {
        event: "models.execution.completed",
        modelId,
        operation,
        providerId: provider.id,
        providerModelId: binding.providerModelId,
        durationMs,
        retailCreditsCharged: noCharge ? 0 : creditsRequired,
        wholesaleCostUsd,
        grossMarginUsd: margin.marginUsd,
        marginPercent: margin.marginPercent,
      },
      `Execution completed for ${modelId} (${operation}) via ${provider.id} in ${durationMs}ms`
    );

    const executionResult = {
      status: "success",
      data: normalizedOutput,
      content: normalizedOutput?.content || normalizedOutput?.text || "",
      text: normalizedOutput?.text || "",
      images: normalizedOutput?.images || [],
      metadata: {
        generationId,
        modelId,
        operation,
        providerUsed: provider.id,
        providerModelId: binding.providerModelId,
        creditsCharged: noCharge ? 0 : creditsRequired,
        wholesaleCostUsd,
        grossMarginUsd: margin.marginUsd,
        marginPercent: margin.marginPercent,
        durationMs,
      },
    };

    // Store in Idempotency Cache if key provided (Task 5)
    if (idempotencyKey && store) {
      await store.set(idempotencyKey, executionResult, {
        ttlSeconds: options.idempotencyTtlSeconds || 3600,
      });
    }

    return executionResult;
  } catch (err) {
    // Record Circuit Breaker Failure (only after all retries exhausted)
    circuitBreakerRegistry.recordFailure(bindingId);

    // Release Wallet Hold
    if (reservation && walletService) {
      await walletService.release(reservation.reservationId, {
        reason: err.message || "Provider execution failed",
      });
      logger.info(
        { event: LogEvents.WALLET_HOLD_RELEASED, userId, reservationId: reservation.reservationId },
        `Released ${creditsRequired} credits due to execution error`
      );
    }

    const normalized = normalizeError(err, { binding, provider });

    logger.error(
      {
        event: "models.execution.failed",
        modelId,
        operation,
        providerId: provider.id,
        error: normalized.message,
        code: normalized.code,
      },
      `Execution failed for ${modelId} (${operation}) via ${provider.id}: ${normalized.message}`
    );

    throw normalized;
  }
}
