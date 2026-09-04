import { calculateCostInternal } from "./pricingFormulas.js";
import { evaluatePricing } from "./pricingEngine.js";
import { getRegistry } from "../registry/loader.js";
import { validateInput } from "../validation/validationService.js";
import {
  UnknownModelFamilyError,
  UnknownOperationError,
  NoServableDeploymentError,
} from "../errors/index.js";
import telemetry, { MODEL_EVENTS } from "../observability/events.js";

export function calculateCost(modelFamily, operation, cleanInputOrUsage = {}, options = {}) {
  const { families, deployments, pricingRules } = getRegistry();
  const effectiveFamily = (!families.has(modelFamily) && modelFamily === "nano_banana_pro") ? "nanobana_pro" : modelFamily;

  if (!families.has(effectiveFamily)) {
    throw new UnknownModelFamilyError(modelFamily);
  }

  const ruleKey = `${effectiveFamily}.${operation}`;
  if (pricingRules && pricingRules.has(ruleKey)) {
    const cleanInput = validateInput(effectiveFamily, operation, cleanInputOrUsage);
    const estimate = evaluatePricing(effectiveFamily, operation, cleanInput);
    telemetry.emit(MODEL_EVENTS.PRICING_CALCULATED, {
      modelFamily: effectiveFamily,
      operation,
      pricingMode: "multi_tier_rule",
      amount: estimate.amountString,
    });
    return estimate;
  }

  // Resolve servable deployment or preferredDeployment
  let deployment = null;
  if (options.preferredDeployment) {
    deployment = deployments.get(options.preferredDeployment);
  } else {
    for (const dep of deployments.values()) {
      if (
        dep.modelFamily === modelFamily &&
        ["active", "deprecated"].includes(dep.status) &&
        dep.operations &&
        dep.operations[operation]
      ) {
        deployment = dep;
        break;
      }
    }
  }

  if (!deployment) {
    throw new NoServableDeploymentError(modelFamily, operation);
  }

  const opConfig = deployment.operations[operation];
  if (!opConfig) {
    throw new UnknownOperationError(modelFamily, operation);
  }

  const pricingDef = opConfig.pricing;

  // For token_based pricing, usage is provided as-is; for others, re-validate input (defense in depth)
  let cleanInput = cleanInputOrUsage;
  if (pricingDef.mode !== "token_based") {
    cleanInput = validateInput(modelFamily, operation, cleanInputOrUsage);
  }

  const amount = calculateCostInternal(cleanInput, pricingDef);

  const costResult = {
    amount,
    currency: "credits",
    pricingMode: pricingDef.mode,
    deploymentUsed: deployment.id,
    inputSnapshot: cleanInput,
    calculatedAt: new Date().toISOString(),
  };

  telemetry.emit(MODEL_EVENTS.PRICING_CALCULATED, {
    modelFamily,
    operation,
    deploymentId: deployment.id,
    pricingMode: pricingDef.mode,
    amount,
  });

  return costResult;
}
