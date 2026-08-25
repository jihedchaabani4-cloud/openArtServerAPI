import Ajv from "ajv";
import addFormats from "ajv-formats";
import { SCHEMA_VERSIONS, getSchemaForVersion } from "./schemaVersionMap.js";
import { ConfigIntegrityError, PricingConfigError } from "../errors/index.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const compiledValidators = new Map();

function getValidator(version, entityType) {
  const key = `${version}:${entityType}`;
  if (compiledValidators.has(key)) {
    return compiledValidators.get(key);
  }
  const schema = getSchemaForVersion(version, entityType);
  const validate = ajv.compile(schema);
  compiledValidators.set(key, validate);
  return validate;
}

export function validateStructural(data, entityType, version = "1.0") {
  const validate = getValidator(version, entityType);
  const valid = validate(data);
  if (!valid) {
    const errorDetails = (validate.errors || [])
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    throw new ConfigIntegrityError(
      `Structural validation failed for ${entityType} "${data?.id || "unknown"}": ${errorDetails}`
    );
  }
  return true;
}

export function validateReferentialIntegrity({ families, providers, deployments }) {
  for (const deployment of deployments.values()) {
    if (!families.has(deployment.modelFamily)) {
      throw new ConfigIntegrityError(
        `Referential integrity failed: deployment "${deployment.id}" references unknown modelFamily "${deployment.modelFamily}"`
      );
    }
    if (!providers.has(deployment.provider)) {
      throw new ConfigIntegrityError(
        `Referential integrity failed: deployment "${deployment.id}" references unknown provider "${deployment.provider}"`
      );
    }
  }
  return true;
}

export function validateSingleServableRule(deployments) {
  // Map of `${modelFamily}:${operation}` -> array of servable deployment IDs
  const servableMap = new Map();

  for (const deployment of deployments.values()) {
    const isServable = ["active", "deprecated"].includes(deployment.status);
    if (!isServable) continue;

    for (const operation of Object.keys(deployment.operations || {})) {
      const key = `${deployment.modelFamily}:${operation}`;
      if (!servableMap.has(key)) {
        servableMap.set(key, []);
      }
      servableMap.get(key).push(deployment.id);
    }
  }

  for (const [key, depIds] of servableMap.entries()) {
    if (depIds.length > 1) {
      throw new ConfigIntegrityError(
        `Single Servable Rule violated: multiple servable deployments (${depIds.join(", ")}) for "${key}"`
      );
    }
  }
  return true;
}

export function validatePricingInputsConsistency(deployment) {
  for (const [opName, opConfig] of Object.entries(deployment.operations || {})) {
    const inputs = opConfig.inputs || {};
    const pricing = opConfig.pricing || {};

    if (pricing.mode === "quality_table") {
      const field = inputs.quality;
      if (!field) {
        throw new PricingConfigError(
          `Deployment "${deployment.id}" operation "${opName}" uses quality_table but has no "quality" input`
        );
      }
    }

    if (pricing.mode === "resolution_table") {
      const field = inputs.resolution;
      if (!field) {
        throw new PricingConfigError(
          `Deployment "${deployment.id}" operation "${opName}" uses resolution_table but has no "resolution" input`
        );
      }
    }

    if (pricing.mode === "formula") {
      if (pricing.multipliers) {
        for (const dim of Object.keys(pricing.multipliers)) {
          const field = inputs[dim];
          if (!field) {
            throw new PricingConfigError(
              `Deployment "${deployment.id}" operation "${opName}" multiplier dimension "${dim}" is not declared in inputs`
            );
          }
          if (!field.required && field.default === undefined) {
            throw new PricingConfigError(
              `Deployment "${deployment.id}" operation "${opName}" multiplier dimension "${dim}" must be required or have a default`
            );
          }
        }
      }
      if (pricing.additive) {
        for (const dim of Object.keys(pricing.additive)) {
          const field = inputs[dim];
          if (!field) {
            throw new PricingConfigError(
              `Deployment "${deployment.id}" operation "${opName}" additive dimension "${dim}" is not declared in inputs`
            );
          }
        }
      }
    }
  }
  return true;
}

export function validatePassthroughCollision(deployment) {
  for (const [opName, opConfig] of Object.entries(deployment.operations || {})) {
    const inputs = Object.keys(opConfig.inputs || {});
    const passthrough = opConfig.allowedPassthrough || [];
    for (const key of passthrough) {
      if (inputs.includes(key)) {
        throw new ConfigIntegrityError(
          `Deployment "${deployment.id}" operation "${opName}" has key collision: "${key}" is in both inputs and allowedPassthrough`
        );
      }
    }
  }
  return true;
}

export function validateAllConsistencyChecks({ families, providers, deployments, collections }) {
  validateReferentialIntegrity({ families, providers, deployments });
  validateSingleServableRule(deployments);
  for (const deployment of deployments.values()) {
    validatePricingInputsConsistency(deployment);
    validatePassthroughCollision(deployment);
  }
  return true;
}
