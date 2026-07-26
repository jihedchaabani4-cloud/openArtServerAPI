/**
 * Use Case Schema Validation
 */
export function validateUseCaseDefinition(def) {
  if (!def) {
    throw new Error("Use Case definition is required");
  }

  const requiredFields = ["useCaseId", "label", "workflowRef", "billing", "inputSchema"];
  for (const field of requiredFields) {
    if (def[field] === undefined || def[field] === null) {
      throw new Error(`Use Case definition is missing required field: "${field}"`);
    }
  }

  if (typeof def.useCaseId !== "string" || !def.useCaseId.trim()) {
    throw new Error("useCaseId must be a non-empty string");
  }

  if (typeof def.label !== "string" || !def.label.trim()) {
    throw new Error("label must be a non-empty string");
  }

  if (typeof def.workflowRef !== "string" || !def.workflowRef.trim()) {
    throw new Error("workflowRef must be a non-empty string");
  }

  if (typeof def.billing !== "object" || typeof def.billing.strategy !== "string") {
    throw new Error("billing.strategy must be a string");
  }

  const allowedStrategies = ["workflow-budget", "per-node", "free"];
  if (!allowedStrategies.includes(def.billing.strategy)) {
    throw new Error(`Invalid billing strategy "${def.billing.strategy}". Allowed values: ${allowedStrategies.join(", ")}`);
  }

  if (typeof def.inputSchema !== "object" || def.inputSchema === null) {
    throw new Error("inputSchema must be an object");
  }

  // Validate fields inside inputSchema
  for (const [key, fieldConfig] of Object.entries(def.inputSchema)) {
    if (typeof fieldConfig !== "object" || fieldConfig === null) {
      throw new Error(`inputSchema field "${key}" must be an object`);
    }
    const allowedTypes = ["string", "number", "enum", "array", "boolean"];
    if (!allowedTypes.includes(fieldConfig.type)) {
      throw new Error(`Invalid type "${fieldConfig.type}" for inputSchema field "${key}". Allowed types: ${allowedTypes.join(", ")}`);
    }
    if (fieldConfig.type === "enum" && (!Array.isArray(fieldConfig.options) || fieldConfig.options.length === 0)) {
      throw new Error(`inputSchema field "${key}" of type "enum" must have a non-empty options array`);
    }
  }

  return true;
}
