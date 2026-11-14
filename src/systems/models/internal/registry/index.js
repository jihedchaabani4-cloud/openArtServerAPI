/**
 * System 2: Models Management — Registry & Schema Subsystem (Internal)
 *
 * Encapsulates model catalog registry, schema validation, and execution binding resolution.
 * All external systems must access models through #models/tools or #models/api.
 */

import {
  initRegistry,
  getRegistry,
  getModel,
  getModelBindings,
  getProvider,
  reloadRegistry,
} from "./modelRegistry.js";
import {
  resolveExecutionPlan,
  resolveConfiguredBinding,
  resolveBindingForTest,
} from "./bindingResolver.js";
import {
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchema as getModelSchemaInternal,
} from "../schema/schemaValidator.js";
import { getModelConfig } from "../catalogPresentation.js";

export {
  initRegistry,
  getRegistry,
  getModel,
  getModelBindings,
  getProvider,
  reloadRegistry,
  resolveExecutionPlan,
  resolveConfiguredBinding,
  resolveBindingForTest,
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchemaInternal,
  getModelConfig,
};

export default {
  initRegistry,
  getRegistry,
  getModel,
  getModelBindings,
  getProvider,
  reloadRegistry,
  resolveExecutionPlan,
  resolveConfiguredBinding,
  resolveBindingForTest,
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchemaInternal,
  getModelConfig,
};
