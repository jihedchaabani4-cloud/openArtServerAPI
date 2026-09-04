import { idempotencyStore } from "./idempotencyStore.js";
import { resolveServableDeployment } from "../deployment/deploymentResolver.js";
import { resolveCredential } from "../credentials/credentialResolver.js";
import { validateInput } from "../validation/validationService.js";
import { getRegistry } from "../registry/loader.js";
import { resolveModelSchema } from "../registry/resolver.js";
import { evaluatePricing } from "../pricing/pricingEngine.js";
import { getProviderClient, getProviderAdapter } from "../registry/providerRuntimeRegistry.js";
import { walletService as defaultWalletService } from "../../services/walletService.js";
import { generationRepository } from "../../repositories/generationRepository.js";
import telemetry, { MODEL_EVENTS } from "../observability/events.js";
import { OutputContractViolationError } from "../errors/index.js";

export async function run(modelFamily, operation, rawInput = {}, options = {}) {
  const startTime = Date.now();
  const {
    idempotencyKey,
    credentialProvider,
    preferredDeployment,
    userId,
    walletService = defaultWalletService,
    generationId: providedGenId,
  } = options;

  const generationId =
    providedGenId || `gen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // 1. Idempotency Cache Check
  if (idempotencyKey) {
    const cached = await idempotencyStore.get(idempotencyKey);
    if (cached) {
      telemetry.emit(MODEL_EVENTS.IDEMPOTENT_REPLAY, {
        idempotencyKey,
        deploymentId: cached.metadata?.deploymentUsed,
      });
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          idempotent: true,
        },
      };
    }
  }

  // 2. Strict Pre-Flight Validation
  const cleanInput = validateInput(modelFamily, operation, rawInput);
  let schemaVersion = "1.0";
  try {
    const resolvedSchema = resolveModelSchema(modelFamily, operation);
    if (resolvedSchema?.schemaVersion) {
      schemaVersion = resolvedSchema.schemaVersion;
    }
  } catch {
    // If model schema not found, fallback to 1.0
  }

  // 3. Pre-Flight Multi-Tier Pricing Calculation
  let priceEstimate;
  try {
    priceEstimate = evaluatePricing(modelFamily, operation, cleanInput);
  } catch {
    priceEstimate = { amount: 0, pricingVersion: "default" };
  }
  const creditsRequired = priceEstimate.amount || 0;
  const pricingVersion = priceEstimate.pricingVersion || "default";

  // 4. Two-Phase Wallet Hold (if userId provided)
  let reservation = null;
  if (userId && walletService) {
    reservation = await walletService.reserve({
      userId,
      amount: creditsRequired,
      model: modelFamily,
      operation,
      pricingVersion,
      referenceId: `res_${generationId}`,
    });
  }

  // 5. Resolve Single Active Deployment & Adapter
  const deployment = resolveServableDeployment(modelFamily, operation, { preferredDeployment });
  const { providers } = getRegistry();
  const provider = providers.get(deployment.provider);

  telemetry.emit(MODEL_EVENTS.DEPLOYMENT_RESOLVED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    providerModelVersion: deployment.providerModelVersion,
  });

  const opConfig = deployment.operations[operation] || {};
  const adapterIdentifier = opConfig.adapter || deployment.adapter || provider.id;
  const adapter = getProviderAdapter(adapterIdentifier);

  // 6. Resolve Credential
  const credential = await resolveCredential(deployment, provider, credentialProvider);

  // 7. Execute Provider Client
  telemetry.emit(MODEL_EVENTS.EXECUTION_STARTED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    idempotencyKey,
  });

  const providerPayload = adapter.toProviderPayload(cleanInput, {
    ...opConfig,
    endpoint: opConfig.endpoint,
    fieldMapping: opConfig.fieldMapping || {},
  });

  const client = getProviderClient(provider.id, {
    baseUrl: provider.baseUrl,
    credential,
    timeoutMs: deployment.timeoutMs || 300000,
  });

  let rawResponse;
  try {
    rawResponse = await client.execute({
      providerModelId: opConfig.providerModelId || deployment.providerModelId,
      payload: providerPayload,
      operation,
      executionConfig: {
        endpoint: opConfig.endpoint,
        ...(opConfig.executionConfig || {}),
      },
    });
  } catch (err) {
    // Release wallet reservation on provider failure
    if (reservation && walletService) {
      await walletService.release(reservation.reservationId, { reason: err.message });
    }

    // Record failed execution snapshot for auditability
    await generationRepository.saveSnapshot({
      generationId,
      userId: userId || null,
      model: modelFamily,
      operation,
      schemaVersion,
      pricingVersion,
      inputsSnapshot: cleanInput,
      creditsCharged: 0,
      providerUsed: provider?.id || null,
      durationMs: Date.now() - startTime,
      status: "failed",
      errorMessage: err.message,
    });

    telemetry.emit(MODEL_EVENTS.EXECUTION_FAILED, {
      modelFamily,
      operation,
      deploymentId: deployment.id,
      errorType: err.name,
      retryable: err.retryable || false,
      latencyMs: Date.now() - startTime,
    });
    throw err;
  }

  // 8. Normalize output & verify output contract
  let normalized;
  try {
    normalized = adapter.fromProviderResponse(rawResponse, opConfig.outputs || opConfig);
    if (!normalized || typeof normalized !== "object") {
      throw new OutputContractViolationError("Adapter returned invalid output format");
    }
  } catch (err) {
    if (reservation && walletService) {
      await walletService.release(reservation.reservationId, { reason: "output_contract_violation" });
    }
    throw err;
  }

  // 9. Commit Wallet Hold upon verified success
  if (reservation && walletService) {
    await walletService.commit(reservation.reservationId, { generationId });
  }

  // 10. Record Immutable Execution Snapshot
  const durationMs = Date.now() - startTime;
  const snapshot = await generationRepository.saveSnapshot({
    generationId,
    userId: userId || null,
    model: modelFamily,
    operation,
    schemaVersion,
    pricingVersion,
    inputsSnapshot: cleanInput,
    creditsCharged: creditsRequired,
    providerUsed: provider.id,
    durationMs,
    status: "success",
  });

  const runResult = {
    ...normalized,
    metadata: {
      generationId,
      deploymentUsed: deployment.id,
      providerModelVersion: deployment.providerModelVersion,
      idempotent: false,
      creditsCharged: creditsRequired,
      schemaVersion,
      pricingVersion,
      snapshot,
    },
  };

  // 11. Store in Idempotency Store
  if (idempotencyKey) {
    await idempotencyStore.set(idempotencyKey, runResult, { ttlSeconds: 3600 });
  }

  telemetry.emit(MODEL_EVENTS.EXECUTION_SUCCEEDED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    latencyMs: durationMs,
  });

  return runResult;
}
