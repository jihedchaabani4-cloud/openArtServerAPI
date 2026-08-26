import { idempotencyStore } from "./idempotencyStore.js";
import { resolveServableDeployment } from "../deployment/deploymentResolver.js";
import { resolveCredential } from "../credentials/credentialResolver.js";
import { validateInput } from "../validation/validationService.js";
import { getRegistry } from "../registry/loader.js";
import { getProviderClient, getProviderAdapter } from "../registry/providerRuntimeRegistry.js";
import telemetry, { MODEL_EVENTS } from "../observability/events.js";
import { OutputContractViolationError } from "../errors/index.js";

export async function run(modelFamily, operation, rawInput = {}, options = {}) {
  const startTime = Date.now();
  const { idempotencyKey, credentialProvider, preferredDeployment } = options;

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

  // 2. Resolve Deployment
  const deployment = resolveServableDeployment(modelFamily, operation, { preferredDeployment });
  const { providers } = getRegistry();
  const provider = providers.get(deployment.provider);

  telemetry.emit(MODEL_EVENTS.DEPLOYMENT_RESOLVED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    providerModelVersion: deployment.providerModelVersion,
  });

  // 3. Validate Input
  const cleanInput = validateInput(modelFamily, operation, rawInput);

  // 4. Resolve Credential
  const credential = await resolveCredential(deployment, provider, credentialProvider);

  // 5. Execution
  telemetry.emit(MODEL_EVENTS.EXECUTION_STARTED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    idempotencyKey,
  });

  const opConfig = deployment.operations[operation];
  const adapter = getProviderAdapter(provider.id);
  const providerPayload = adapter.toProviderPayload(cleanInput, opConfig.fieldMapping || {});

  const client = getProviderClient(provider.id, {
    baseUrl: provider.baseUrl,
    credential,
    timeoutMs: deployment.timeoutMs || 60000,
  });

  let rawResponse;
  try {
    rawResponse = await client.execute({
      providerModelId: deployment.providerModelId,
      payload: providerPayload,
      operation,
      executionConfig: {
        endpoint: opConfig.endpoint,
        ...(opConfig.executionConfig || {}),
      },
    });
  } catch (err) {
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

  // 6. Normalize output & verify output contract
  const normalized = adapter.fromProviderResponse(rawResponse, opConfig.outputs);
  if (!normalized || typeof normalized !== "object") {
    throw new OutputContractViolationError("Adapter returned invalid output format");
  }

  const runResult = {
    ...normalized,
    metadata: {
      deploymentUsed: deployment.id,
      providerModelVersion: deployment.providerModelVersion,
      idempotent: false,
    },
  };

  // 7. Store in Idempotency Store
  if (idempotencyKey) {
    await idempotencyStore.set(idempotencyKey, runResult, { ttlSeconds: 3600 });
  }

  telemetry.emit(MODEL_EVENTS.EXECUTION_SUCCEEDED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    latencyMs: Date.now() - startTime,
  });

  return runResult;
}
