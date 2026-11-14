/**
 * System 2: Models Management — Provider Resolvers & Adapters (Internal)
 *
 * Encapsulates external AI provider adapters (WaveSpeed, Google GenAI, LLMService),
 * provider runtime registries, and credential resolvers.
 */

import {
  WaveSpeedImageResolver,
  resolveImageRoute as resolveWaveSpeedImageRoute,
} from "../runtime/wavespeed/image/resolver.js";
import {
  resolveWaveSpeedRoute,
} from "../runtime/wavespeed/resolver.js";
import {
   evaluateWaveSpeedRoutes,
} from "../runtime/wavespeed/common/routeEvaluator.js";
import {
  resolveProviderRoute,
  registerProviderResolver,
  getRunner,
  registerProviderRunner,
  unregisterProviderRunner,
  executeProvider,
} from "../runtime/providerRuntimeRegistry.js";
import {
  resolveExecutionRoute,
} from "../runtime/routeResolver.js";
import {
  resolveCredential,
} from "../credentials/credentialResolver.js";
import {
  LLMService,
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
} from "./LLMService.js";
import {
  PromptService,
} from "./PromptService.js";

export {
  WaveSpeedImageResolver,
  resolveWaveSpeedImageRoute,
  resolveWaveSpeedRoute,
  evaluateWaveSpeedRoutes,
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
  evaluateWaveSpeedRoutes,
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
