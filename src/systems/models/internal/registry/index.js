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
  reloadRegistry,
} from "../../../../models/registry/modelRegistry.js";
import {
  resolveExecutionPlan,
  resolveConfiguredBinding,
} from "../../../../models/registry/bindingResolver.js";
import {
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchema as getModelSchemaInternal,
} from "../../../../models/schema/schemaValidator.js";
import { getModelConfig } from "../../../../models/catalogPresentation.js";

export {
  initRegistry,
  getRegistry,
  getModel,
  reloadRegistry,
  resolveExecutionPlan,
  resolveConfiguredBinding,
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchemaInternal,
  getModelConfig,
};

export default {
  initRegistry,
  getRegistry,
  getModel,
  reloadRegistry,
  resolveExecutionPlan,
  resolveConfiguredBinding,
  validateCanonicalInput,
  validateBindingConstraints,
  getModelSchemaInternal,
  getModelConfig,
};
