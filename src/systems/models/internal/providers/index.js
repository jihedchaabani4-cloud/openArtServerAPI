/**
 * System 2: Models Management — Provider Resolvers & Adapters (Internal)
 *
 * Encapsulates external AI provider adapters (WaveSpeed, Google GenAI, LLMService),
 * provider runtime registries, and credential resolvers.
 */

import {
  WaveSpeedImageResolver,
  resolveImageRoute as resolveWaveSpeedImageRoute,
} from "../../../../models/runtime/wavespeed/image/resolver.js";
import {
  resolveWaveSpeedRoute,
} from "../../../../models/runtime/wavespeed/resolver.js";
import {
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
} from "../../../../models/runtime/providerRuntimeRegistry.js";
import {
  resolveExecutionRoute,
} from "../../../../models/runtime/routeResolver.js";
import {
  resolveCredential,
} from "../../../../models/credentials/credentialResolver.js";
import {
  LLMService,
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
} from "../../../../platform/ai/LLMService.js";
import {
  PromptService,
} from "../../../../platform/ai/PromptService.js";

export {
  WaveSpeedImageResolver,
  resolveWaveSpeedImageRoute,
  resolveWaveSpeedRoute,
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
  resolveExecutionRoute,
  resolveCredential,
  LLMService,
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
  PromptService,
};

export default {
  WaveSpeedImageResolver,
  resolveWaveSpeedImageRoute,
  resolveWaveSpeedRoute,
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
  resolveExecutionRoute,
  resolveCredential,
  LLMService,
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
  PromptService,
};
