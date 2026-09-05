import { getModel, getProvider } from "../registry/modelRegistry.js";
import { resolveBinding } from "../registry/bindingResolver.js";
import { validateCanonicalInput, validateBindingConstraints } from "../schema/schemaValidator.js";
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
 * Universal Model Runner (Phase 1 — Deterministic Explicit Binding Orchestrator)
 *
 * Coordinates validation, pricing calculation, explicit binding resolution,
 * payload translation, execution, output validation, and telemetry.
 *
 * Invariant Principles:
 *   1. Explicit Binding: In Phase 1, execution targets an explicit or default binding.
 *      No automatic failover to another provider on failure.
 *   2. Financial Boundary: Models System does NOT own the wallet lifecycle.
 *      Workflow / Use Case layer manages holds and commits.
 *   3. Zero Silent Fallback: Missing runtime declarations throw ConfigIntegrityError.
 *   4. Output Defense: Missing or empty image/video URLs throw OutputContractViolationError.
 */
export async function run(modelId, operation, rawInput = {}, options = {}) {
  const startTime = Date.now();
  const generationId = options.generationId || `gen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const userId = options.userId || null;
  const noCharge = Boolean(options.noCharge);
  const noChargeReason = options.reason || options.noChargeReason || null;
  const skipWalletHold = Boolean(options.skipWalletHold || !options.walletService);

  // Optional billing bridge for backward compatibility with isolated test harnesses
  const billing = options.billingBridge || (options.walletService ? new BillingBridge(options.walletService) : null);
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

  // 2. Resolve Logical Model & Operation Def
  const model = options.model || getModel(modelId);
  const opDef = model.operations?.[operation];
  if (!opDef) {
    throw new Error(`Operation "${operation}" not supported for model "${modelId}"`);
  }

  // 3. Resolve Explicit Binding (Phase 1: Deterministic resolution, no auto-failover)
  const binding = resolveBinding(
    options.bindingId || options.preferredProvider,
    model.id,
    operation
  );
  const provider = getProvider(binding.providerId);
  const bindingId = `${binding.modelId}:${binding.operation}:${binding.providerId}`;

  // 4. Validate Canonical Input (Model Universe & Conditional Rules)
  const cleanInput = validateCanonicalInput(opDef, rawInput, {
    allowUnknown: options.allowUnknown || false,
  });

  // 5. Enforce Binding Implementation Constraints (Narrowing Only)
  // Rejects inputs not supported by this specific binding (e.g. 21:9 or 4k when unmapped)
  validateBindingConstraints(binding, cleanInput);

  // 6. Idempotency Check — return early if duplicate key exists
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

  // 7. Pure Pricing Evaluation (Telemetry & optional legacy harness)
  const creditsRequired = calculateRetailCredits(model, operation, cleanInput, binding);
  const wholesaleCostUsd = calculateWholesaleCostUsd(binding, cleanInput);
  const margin = calculateMargin(creditsRequired, wholesaleCostUsd);

  // 8. Financial Hold (Only if walletService explicitly injected by legacy test harness)
  let reservation = null;
  if (billing && !skipWalletHold) {
    reservation = await billing.reserveHold({
      userId,
      amount: creditsRequired,
      modelId,
      operation,
      generationId,
      noCharge,
      skipWalletHold,
    });
  }

  // 9. Resolve Credential (BYOK isolated by userId)
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

  // 10. Translate Payload (Declarative parameterMap + valueMap OR Custom Adapter)
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

  // 11. Execute Provider via RuntimeExecutor (Retries for transient errors; NO auto-failover to provider B)
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
    circuitBreakerRegistry.recordFailure(bindingId);
    if (billing && reservation) {
      await billing.releaseHold(reservation, { userId, creditsRequired, reason: err.message });
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
    // Explicit Failure in Phase 1: Fail immediately, do not switch providers
    throw normalized;
  }

  // 12. Normalize Output & Validate Strict Output Contract
  try {
    let normalizedOutput;
    if (customAdapter && typeof customAdapter.fromProviderResponse === "function") {
      normalizedOutput = customAdapter.fromProviderResponse(rawResponse, binding);
    } else {
      normalizedOutput = mapFromProviderResponse(rawResponse, binding);
    }

    // Strict output validation (throws OutputContractViolationError on empty/missing URLs)
    validateOutput(normalizedOutput, binding, model.domain);

    // Record Circuit Breaker Success
    circuitBreakerRegistry.recordSuccess(bindingId);

    // Commit legacy reservation if active
    if (billing && reservation) {
      await billing.commitHold(reservation, {
        creditsCharged: creditsRequired,
        generationId,
      });
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

    // Store in Idempotency Cache if key provided
    if (idempotencyKey && store) {
      await store.set(idempotencyKey, executionResult, {
        ttlSeconds: options.idempotencyTtlSeconds || 3600,
      });
    }

    return executionResult;
  } catch (err) {
    circuitBreakerRegistry.recordFailure(bindingId);
    if (billing && reservation) {
      await billing.releaseHold(reservation, { userId, creditsRequired, reason: err.message });
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
      `Post-execution processing failed for ${modelId} (${operation}) via ${provider.id}: ${normalized.message}`
    );
    throw normalized;
  }
}
