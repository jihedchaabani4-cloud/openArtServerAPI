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
  const walletService = options.walletService || defaultWalletService;

  // 1. Resolve Model
  const model = options.model || getModel(modelId);
  const opDef = model.operations?.[operation];
  if (!opDef) {
    throw new Error(`Operation "${operation}" not supported for model "${modelId}"`);
  }

  // 2. Validate Canonical Input
  const cleanInput = validateCanonicalInput(opDef.canonicalInputs || {}, rawInput, {
    allowUnknown: options.allowUnknown || false,
  });

  // 3. Evaluate Fixed Retail Pricing
  const creditsRequired = calculateRetailCredits(model, operation, cleanInput);

  // 4. Two-Phase Wallet Hold (Reservation)
  let reservation = null;
  if (userId && walletService && creditsRequired > 0) {
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

  // 5. Two-Phase Binding Selection (Capability ➔ Health ➔ Priority)
  const binding = selectBinding(modelId, operation, cleanInput, {
    ...options,
    model,
  });
  const provider = getProvider(binding.providerId);
  const bindingId = `${binding.modelId}:${binding.operation}:${binding.providerId}`;

  // 6. Wholesale Margin Evaluation
  const wholesaleCostUsd = calculateWholesaleCostUsd(binding, cleanInput);
  const margin = calculateMargin(creditsRequired, wholesaleCostUsd);

  // 7. Resolve Credential
  let credential = null;
  try {
    const credResult = await resolveCredential(binding, provider, options.credentialProvider);
    credential = credResult?.apiKey || null;
  } catch (err) {
    // If running in mocked test environment or BYOK is optional, allow fallback
    credential = options.credential || null;
    if (!credential && provider.authType !== "none") {
      // If still missing, log warning or let provider throw if credentials required
    }
  }

  // 8. Transform to Provider Payload
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

  // 9. Execute External Provider
  let rawResponse;
  try {
    if (binding.streaming && options.onStreamChunk) {
      // LLM Streaming path
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
        retailCreditsCharged: creditsRequired,
        wholesaleCostUsd,
        grossMarginUsd: margin.marginUsd,
        marginPercent: margin.marginPercent,
      },
      `Execution completed for ${modelId} (${operation}) via ${provider.id} in ${durationMs}ms`
    );

    return {
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
        creditsCharged: creditsRequired,
        wholesaleCostUsd,
        grossMarginUsd: margin.marginUsd,
        marginPercent: margin.marginPercent,
        durationMs,
      },
    };
  } catch (err) {
    // Record Circuit Breaker Failure
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
