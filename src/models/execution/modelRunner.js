import { getModel, getProvider } from "../registry/modelRegistry.js";
import { resolveBinding } from "../registry/bindingResolver.js";
import { resolveExecutionRoute } from "../runtime/routeResolver.js";
import { validateCanonicalInput, validateBindingConstraints, getModelSchema } from "../schema/schemaValidator.js";
import { mapToProviderPayload, mapFromProviderResponse } from "../mapping/parameterMapper.js";
import { validateOutput } from "../mapping/outputValidator.js";
import { calculateRetailCredits, calculateWholesaleCostUsd, calculateMargin } from "../pricing/pricingEngine.js";
import { circuitBreakerRegistry } from "./circuitBreaker.js";
import { normalizeError } from "./errorNormalizer.js";
import { defaultRuntimeExecutor } from "./runtimeExecutor.js";
import { getCustomAdapter } from "../runtime/adapters/adapterLoader.js";
import { resolveCredential } from "../credentials/credentialResolver.js";
import { idempotencyStore as defaultIdempotencyStore } from "./idempotencyStore.js";
import { MissingUserIdError, ProviderTransientError } from "../errors/index.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const logger = createLogger("models");

/**
 * Universal Model Runner (Model-First Provider-Owned Architecture)
 *
 * Coordinates validation, pricing calculation, provider resolution, route resolution,
 * payload translation, execution, output validation, and telemetry.
 *
 * Invariants:
 *   1. Model-First: Callers supply ONLY modelId and semantic parameters.
 *      Zero operation, provider, or binding arguments.
 *   2. Provider Ownership: Route selection (e.g. edit vs generation) belongs exclusively
 *      to the Provider implementation/configuration, not generic Models Core.
 *   3. Financial Isolation: Models system is 100% financial-agnostic.
 *   4. Output Defense: Missing or empty media URLs throw OutputContractViolationError.
 */
export async function run(modelId, rawInput = {}, options = {}) {
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
        reason: noChargeReason || "unspecified",
        caller: options.caller || "unknown",
      },
      `Model execution permitted without charge (reason: "${noChargeReason || 'unspecified'}") for ${modelId}`
    );
  }

  // 2. Resolve Logical Model
  const model = options.model || getModel(modelId);

  // 3. Resolve Model Schema and Validate Canonical Semantic Inputs
  // Uses authoritative model-level schema, merging all parameters if legacy operations exist.
  const schema = getModelSchema(model);
  const cleanInput = validateCanonicalInput(schema, rawInput, {
    allowUnknown: options.allowUnknown || false,
  });

  // 4. Resolve Configured Provider Implementation (Binding)
  const binding = resolveBinding(model.id, options);

  // 5. Provider Runtime Layer resolves concrete execution route based on semantic inputs
  const route = resolveExecutionRoute(binding, cleanInput);
  const provider = getProvider(route.providerId);
  const bindingId = `${route.modelId}:${route.providerId}`;

  // 6. Enforce Binding Implementation Constraints
  validateBindingConstraints(route, cleanInput, rawInput);

  // 7. Idempotency Check — return early if duplicate key or in-flight promise exists
  const idempotencyKey = options.idempotencyKey || rawInput.idempotencyKey || null;
  const store = options.idempotencyStore || defaultIdempotencyStore;
  if (idempotencyKey && store) {
    const cachedResult = await store.get(idempotencyKey);
    if (cachedResult) {
      logger.info(
        { event: "models.execution.idempotency_hit", idempotencyKey, modelId },
        `Idempotency cache hit for key "${idempotencyKey}". Returning cached execution result without re-billing.`
      );
      return cachedResult;
    }
    const inFlightPromise = typeof store.getInFlight === "function" ? store.getInFlight(idempotencyKey) : null;
    if (inFlightPromise) {
      logger.info(
        { event: "models.execution.idempotency_in_flight", idempotencyKey, modelId },
        `Idempotency in-flight hit for key "${idempotencyKey}". Awaiting active execution.`
      );
      return await inFlightPromise;
    }
  }

  const executeInternal = async () => {
    // 8. Pure Pricing Evaluation (telemetry & margin — no wallet interaction)
    const creditsRequired = calculateRetailCredits(model, cleanInput, route);
    const wholesaleCostUsd = calculateWholesaleCostUsd(route, cleanInput);
    const margin = calculateMargin(creditsRequired, wholesaleCostUsd);

    // 9. Resolve Credential (BYOK isolated by userId)
    let credential = null;
    try {
      const credResult = await resolveCredential(
        route,
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
    const customAdapter = route.customAdapter ? await getCustomAdapter(route.customAdapter) : null;
    const providerPayload = typeof customAdapter?.toProviderPayload === "function"
      ? customAdapter.toProviderPayload(cleanInput, route)
      : mapToProviderPayload(cleanInput, route);

    // 11. Check Circuit Breaker
    if (!circuitBreakerRegistry.isAvailable(bindingId)) {
      throw new ProviderTransientError(
        `Provider binding "${bindingId}" is temporarily unavailable (circuit breaker OPEN)`
      );
    }

    // 12. Execute Provider via RuntimeExecutor
    let rawResponse;
    try {
      rawResponse = await executor.execute({
        provider,
        binding: route,
        providerPayload,
        credential,
        modelId,
        bindingId,
        options,
      });
    } catch (err) {
      circuitBreakerRegistry.recordFailure(bindingId);
      const normalized = normalizeError(err, { binding: route, provider });
      logger.error(
        {
          event: "models.execution.failed",
          modelId,
          providerId: provider.id,
          error: normalized.message,
          code: normalized.code,
        },
        `Execution failed for ${modelId} via ${provider.id}: ${normalized.message}`
      );
      throw normalized;
    }

    // 13. Normalize Output & Validate Strict Output Contract
    const normalizedOutput = typeof customAdapter?.fromProviderResponse === "function"
      ? customAdapter.fromProviderResponse(rawResponse, route)
      : mapFromProviderResponse(rawResponse, route);

    // Throws OutputContractViolationError on empty/missing image or video URLs
    validateOutput(normalizedOutput, route, model.domain);

    circuitBreakerRegistry.recordSuccess(bindingId);

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        event: "models.execution.completed",
        modelId,
        providerId: provider.id,
        providerModelId: route.providerModelId,
        durationMs,
        retailCreditsCharged: noCharge ? 0 : creditsRequired,
        wholesaleCostUsd,
        grossMarginUsd: margin.marginUsd,
        marginPercent: margin.marginPercent,
      },
      `Execution completed for ${modelId} via ${provider.id} in ${durationMs}ms`
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
        operation: route.operation || route.id || "execution",
        routeId: route.id || route.routeId || null,
        creditsCharged: noCharge ? 0 : creditsRequired,
        durationMs,
      },
      _internal: {
        providerId: provider.id,
        bindingId: route.id || bindingId,
        providerModelId: route.providerModelId,
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
