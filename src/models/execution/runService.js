import { idempotencyStore } from "./idempotencyStore.js";
import { resolveServableDeployment } from "../deployment/deploymentResolver.js";
import { resolveCredential } from "../credentials/credentialResolver.js";
import { validateInput } from "../validation/validationService.js";
import { getRegistry } from "../registry/loader.js";

// Providers Dedicated Clients
import { WaveSpeedClient } from "../../providers/wavespeed/client.js";
import { GoogleClient } from "../../providers/google/client.js";
import { GroqClient } from "../../providers/groq/client.js";
import { FalClient } from "../../providers/fal/client.js";
import { ReplicateClient } from "../../providers/replicate/client.js";

// Providers Adapters
import { wavespeedAdapter } from "../../adapters/wavespeedAdapter.js";
import { googleAdapter } from "../../adapters/googleAdapter.js";
import { groqAdapter } from "../../adapters/groqAdapter.js";
import { falAdapter } from "../../adapters/falAdapter.js";
import { replicateAdapter } from "../../adapters/replicateAdapter.js";

import telemetry, { MODEL_EVENTS } from "../observability/events.js";
import { OutputContractViolationError } from "../errors/index.js";

const ADAPTERS = {
  wavespeed: wavespeedAdapter,
  google: googleAdapter,
  groq: groqAdapter,
  fal: falAdapter,
  replicate: replicateAdapter,
};

const CLIENT_FACTORIES = {
  wavespeed: (cfg) => new WaveSpeedClient(cfg),
  google:    (cfg) => new GoogleClient(cfg),
  groq:      (cfg) => new GroqClient(cfg),
  fal:       (cfg) => new FalClient(cfg),
  replicate: (cfg) => new ReplicateClient(cfg),
};

function getClientForProvider(provider, credential) {
  const factory = CLIENT_FACTORIES[provider.id] || ((cfg) => new WaveSpeedClient(cfg));
  return factory({
    baseUrl: provider.baseUrl,
    apiKey: credential.apiKey,
  });
}

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
  const adapter = ADAPTERS[provider.id] || wavespeedAdapter;
  const providerPayload = adapter.toProviderPayload(cleanInput, opConfig.fieldMapping || {});

  const client = getClientForProvider(provider, credential);

  let rawResponse;
  try {
    rawResponse = await client.execute({
      providerModelId: deployment.providerModelId,
      payload: providerPayload,
      endpoint: opConfig.endpoint,
      operation,
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
