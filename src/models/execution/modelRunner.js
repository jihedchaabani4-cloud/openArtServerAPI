import { getModel, getProvider } from "../registry/modelRegistry.js";
import { validateCanonicalInput } from "../schema/schemaValidator.js";
import { selectBinding } from "../registry/bindingSelector.js";
import { mapToProviderPayload, mapFromProviderResponse } from "../mapping/parameterMapper.js";
import { validateOutput } from "../mapping/outputValidator.js";
import { calculateRetailCredits, calculateWholesaleCostUsd, calculateMargin } from "../pricing/pricingEngine.js";
import { circuitBreakerRegistry } from "./circuitBreaker.js";
import { normalizeError } from "./errorNormalizer.js";
import { defaultRuntimeExecutor } from "./runtimeExecutor.js";
import { getCustomAdapter } from "../runtime/adapters/adapterLoader.js";
import { resolveCredential } from "../credentials/credentialResolver.js";
import { BillingBridge, defaultBillingBridge } from "./billingBridge.js";
import { idempotencyStore as defaultIdempotencyStore } from "./idempotencyStore.js";
import { MissingUserIdError } from "../errors/index.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Universal Model Runner (Freeze V2 — Lean Orchestrator)
 *
 * Coordinates validation, pricing resolution, wallet holds, binding routing,
 * payload translation, execution, output validation, and telemetry.
 */
export async function run(modelId, operation, rawInput = {}, options = {}) {
  const startTime = Date.now();
  const generationId = options.generationId || `gen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const userId = options.userId || null;
  const noCharge = Boolean(options.noCharge);
  const noChargeReason = options.reason || options.noChargeReason || null;
  const skipWalletHold = Boolean(options.skipWalletHold);

  const billing = options.billingBridge || (options.walletService ? new BillingBridge(options.walletService) : defaultBillingBridge);
  const executor = options.runtimeExecutor || defaultRuntimeExecutor;

  // 1. Enforce userId requirement unless noCharge explicitly granted
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

  // 2. Resolve Model & Operation
  const model = options.model || getModel(modelId);
  const opDef = model.operations?.[operation];
  if (!opDef) {
    throw new Error(`Operation "${operation}" not supported for model "${modelId}"`);
  }

  // 3. Validate Canonical Input (Model Universe & Conditional Rules)
  const cleanInput = validateCanonicalInput(opDef, rawInput, {
    allowUnknown: options.allowUnknown || false,
  });

  // 4. Idempotency Check — return early before wallet hold or provider call
  const idempotencyKey = options.idempotencyKey || rawInput.idempotencyKey || null;
  const store = options.idempotencyStore || defaultIdempotencyStore;
  if (idempotencyKey && store) {
    const cachedResult = await store.get(idempotencyKey);
    if (cachedResult) {
      logger.info(
        { event: "models.execution.idempotency_hit", idempotencyKey, modelId, operation },
        `Idempotency cache hit for key "${idempotencyKey}". Returning cached execution result without re-billing.`
      );
      return cachedResult;
    }
  }

  // 5. Select Binding (Capability Filter -> Health Check -> Priority Sort)
  const binding = selectBinding(modelId, operation, cleanInput, { ...options, model });
  const provider = getProvider(binding.providerId);
  const bindingId = `${binding.modelId}:${binding.operation}:${binding.providerId}`;

  // 6. Pricing Evaluation (Model Retail Price with Binding-level Override support)
  const creditsRequired = calculateRetailCredits(model, operation, cleanInput, binding);
  const wholesaleCostUsd = calculateWholesaleCostUsd(binding, cleanInput);
  const margin = calculateMargin(creditsRequired, wholesaleCostUsd);

  // 7. Two-Phase Wallet Hold
  const reservation = await billing.reserveHold({
    userId,
    amount: creditsRequired,
    modelId,
    operation,
    generationId,
    noCharge,
    skipWalletHold,
  });

  // 8. Resolve Credential (BYOK isolated by userId)
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
  } catch {
    credential = options.credential || null;
  }

  // 9. Translate to Provider Payload (Declarative parameterMap + valueMap OR Custom Adapter)
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

  // 10. Execute External Provider via RuntimeExecutor (Retries, Backoff, Streaming)
  let rawResponse;
  try {
    rawResponse = await executor.execute({
      provider,
      binding,
      providerPayload,
      credential,
      modelId,
      operation,
      bindingId,
      options,
    });
  } catch (err) {
    // Failure in provider execution: trip breaker, release wallet hold, rethrow normalized error
    circuitBreakerRegistry.recordFailure(bindingId);
    await billing.releaseHold(reservation, { userId, creditsRequired, reason: err.message });
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

  // 11. Normalize Output & Validate Strict Output Contract
  try {
    let normalizedOutput;
    if (customAdapter && typeof customAdapter.fromProviderResponse === "function") {
      normalizedOutput = customAdapter.fromProviderResponse(rawResponse, binding);
    } else {
      normalizedOutput = mapFromProviderResponse(rawResponse, binding);
    }

    // Strict output validation (fail-fast: throws OutputContractViolationError on empty URLs)
    validateOutput(normalizedOutput, binding, model.domain);

    // Record Circuit Breaker Success
    circuitBreakerRegistry.recordSuccess(bindingId);

    // Commit Wallet Hold
    await billing.commitHold(reservation, {
      creditsCharged: creditsRequired,
      generationId,
    });

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

    // Store in Idempotency Cache if key provided
    if (idempotencyKey && store) {
      await store.set(idempotencyKey, executionResult, {
        ttlSeconds: options.idempotencyTtlSeconds || 3600,
      });
    }

    return executionResult;
  } catch (err) {
    circuitBreakerRegistry.recordFailure(bindingId);
    await billing.releaseHold(reservation, { userId, creditsRequired, reason: err.message });
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
      `Post-execution processing failed for ${modelId} (${operation}) via ${provider.id}: ${normalized.message}`
    );
    throw normalized;
  }
}
