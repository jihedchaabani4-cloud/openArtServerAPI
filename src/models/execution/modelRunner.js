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
import { idempotencyStore as defaultIdempotencyStore } from "./idempotencyStore.js";
import { MissingUserIdError, MissingOptionError, ProviderTransientError } from "../errors/index.js";
import { createLogger } from "../../infrastructure/logging/index.js";

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
 *   2. Financial Boundary: Models System is 100% financial-agnostic.
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

  // 3. Resolve Configured Implementation (Binding)
  // In Phase 1: Each model + operation has exactly one configured active provider implementation.
  // The caller does NOT specify a provider or bindingId.
  const binding = resolveBinding(model.id, operation, options);
  const provider = getProvider(binding.providerId);
  const bindingId = `${binding.modelId}:${binding.operation}:${binding.providerId}`;

  // 4. Validate Canonical Input (Model Universe & Conditional Rules)
  const cleanInput = validateCanonicalInput(opDef, rawInput, {
    allowUnknown: options.allowUnknown || false,
  });

  // 5. Enforce Binding Implementation Constraints (Narrowing & Parameter Support)
  // Rejects inputs not supported by this specific binding (e.g. unmapped parameters or unmapped enum values)
  validateBindingConstraints(binding, cleanInput, rawInput);

  // 6. Idempotency Check — return early if duplicate key or in-flight promise exists
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
    const inFlightPromise = typeof store.getInFlight === "function" ? store.getInFlight(idempotencyKey) : null;
    if (inFlightPromise) {
      logger.info(
        { event: "models.execution.idempotency_in_flight", idempotencyKey, modelId, operation },
        `Idempotency in-flight hit for key "${idempotencyKey}". Awaiting active execution.`
      );
      return await inFlightPromise;
    }
  }

  const executeInternal = async () => {
    // 7. Pure Pricing Evaluation (telemetry & margin — no wallet interaction)
    const creditsRequired = calculateRetailCredits(model, operation, cleanInput, binding);
    const wholesaleCostUsd = calculateWholesaleCostUsd(binding, cleanInput);
    const margin = calculateMargin(creditsRequired, wholesaleCostUsd);

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

    // 9. Translate Payload (Declarative parameterMap + valueMap OR Custom Adapter)
    const customAdapter = binding.customAdapter ? await getCustomAdapter(binding.customAdapter) : null;
    const providerPayload = typeof customAdapter?.toProviderPayload === "function"
      ? customAdapter.toProviderPayload(cleanInput, binding)
      : mapToProviderPayload(cleanInput, binding);

    // 10. Check Circuit Breaker for explicit binding
    if (!circuitBreakerRegistry.isAvailable(bindingId)) {
      throw new ProviderTransientError(
        `Provider binding "${bindingId}" is temporarily unavailable (circuit breaker OPEN)`
      );
    }

    // 11. Execute Provider via RuntimeExecutor
    // Retries transient errors within same binding. NO automatic failover to another provider.
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

    // 12. Normalize Output & Validate Strict Output Contract
    const normalizedOutput = typeof customAdapter?.fromProviderResponse === "function"
      ? customAdapter.fromProviderResponse(rawResponse, binding)
      : mapFromProviderResponse(rawResponse, binding);

    // Throws OutputContractViolationError on empty/missing image or video URLs
    validateOutput(normalizedOutput, binding, model.domain);

    circuitBreakerRegistry.recordSuccess(bindingId);

    const durationMs = Date.now() - startTime;

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

    const isVideo = model.domain === "video";
    const videoList =
      normalizedOutput?.videos ||
      (isVideo && normalizedOutput?.images?.length ? normalizedOutput.images : []);

    const executionResult = {
      status: "success",
      data: normalizedOutput,
      content: normalizedOutput?.content || normalizedOutput?.text || "",
      text: normalizedOutput?.text || "",
      images: normalizedOutput?.images || [],
      videos: videoList,
      metadata: {
        generationId,
        modelId: model.id,
        operation,
        creditsCharged: noCharge ? 0 : creditsRequired,
        durationMs,
      },
      // Internal execution telemetry strictly for Models testing
      _internal: {
        providerId: provider.id,
        bindingId: binding.id || bindingId,
        providerModelId: binding.providerModelId,
        wholesaleCostUsd,
        grossMarginUsd: margin.marginUsd,
        marginPercent: margin.marginPercent,
      },
    };

    if (idempotencyKey && store) {
      await store.set(idempotencyKey, executionResult, {
        ttlSeconds: options.idempotencyTtlSeconds || 3600,
      });
    }

    return executionResult;
  };

  if (idempotencyKey && store && typeof store.setInFlight === "function") {
    const execPromise = (async () => {
      try {
        return await executeInternal();
      } finally {
        if (typeof store.clearInFlight === "function") {
          store.clearInFlight(idempotencyKey);
        }
      }
    })();
    store.setInFlight(idempotencyKey, execPromise);
    return await execPromise;
  }

  return await executeInternal();
}
