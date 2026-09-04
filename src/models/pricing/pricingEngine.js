import { Decimal } from "decimal.js";
import { getRegistry } from "../registry/loader.js";
import { calculateCostInternal } from "./pricingFormulas.js";
import { PricingConfigError } from "../errors/index.js";

/**
 * Evaluates the credit price for a generation request using decoupled multi-tier pricing rules.
 *
 * @param {string} modelFamily
 * @param {string} operation
 * @param {object} cleanInput
 * @returns {object} PriceEstimate
 */
export function evaluatePricing(modelFamily, operation, cleanInput = {}) {
  const { pricingRules, deployments } = getRegistry();
  const effectiveFamily = (modelFamily === "nano_banana_pro" && !pricingRules.has(`${modelFamily}.${operation}`)) ? "nanobana_pro" : modelFamily;
  const ruleKey = `${effectiveFamily}.${operation}`;
  const rule = pricingRules.get(ruleKey);

  // Fallback to legacy deployment-level pricing if no standalone pricing rule exists
  if (!rule) {
    for (const dep of deployments.values()) {
      if (dep.modelFamily === modelFamily && dep.operations?.[operation]?.pricing) {
        const legacyAmountStr = calculateCostInternal(cleanInput, dep.operations[operation].pricing);
        const num = Math.ceil(Number(legacyAmountStr));
        return {
          amount: num,
          amountString: legacyAmountStr,
          currency: "credits",
          basePrice: num,
          modifiersApplied: [],
          pricingVersion: "legacy"
        };
      }
    }
    throw new PricingConfigError(`No pricing rule or deployment pricing found for "${ruleKey}"`);
  }

  // 1. Calculate Base Cost
  let basePriceDecimal;
  if (rule.base_price_per_unit) {
    const { unit_param, rate_per_unit } = rule.base_price_per_unit;
    const count = Number(cleanInput[unit_param] ?? 1);
    if (count <= 0 || Number.isNaN(count)) {
      throw new PricingConfigError(`Invalid unit count for pricing param "${unit_param}": ${cleanInput[unit_param]}`);
    }
    basePriceDecimal = new Decimal(rate_per_unit).times(count);
  } else if (rule.base_price !== undefined) {
    basePriceDecimal = new Decimal(rule.base_price);
  } else {
    throw new PricingConfigError(`Pricing rule "${ruleKey}" must declare base_price or base_price_per_unit`);
  }

  let totalDecimal = new Decimal(basePriceDecimal);
  const modifiersApplied = [];
  const modifiersMap = rule.modifiers || {};

  // 2. Multipliers first
  for (const [param, paramModifiers] of Object.entries(modifiersMap)) {
    const val = cleanInput[param];
    if (val === undefined || val === null) continue;

    const modifier = paramModifiers[String(val)];
    if (!modifier) continue; // Unmentioned or neutral value (1.0x)

    if (modifier.type === "multiplier") {
      totalDecimal = totalDecimal.times(modifier.factor);
      modifiersApplied.push({
        param,
        value: val,
        type: "multiplier",
        impact: modifier.factor,
        description: modifier.description || `${param}=${val} (×${modifier.factor})`
      });
    }
  }

  // 3. Flat Addons and Per-Unit Additions
  for (const [param, paramModifiers] of Object.entries(modifiersMap)) {
    const val = cleanInput[param];
    if (val === undefined || val === null) continue;

    const modifier = paramModifiers[String(val)];
    if (!modifier) continue;

    if (modifier.type === "flat_addon") {
      totalDecimal = totalDecimal.plus(modifier.amount);
      modifiersApplied.push({
        param,
        value: val,
        type: "flat_addon",
        impact: modifier.amount,
        description: modifier.description || `${param}=${val} (+${modifier.amount} credits)`
      });
    } else if (modifier.type === "per_unit") {
      const add = new Decimal(modifier.rate).times(Number(val));
      totalDecimal = totalDecimal.plus(add);
      modifiersApplied.push({
        param,
        value: val,
        type: "per_unit",
        impact: modifier.rate,
        description: modifier.description || `${param}=${val} (rate ${modifier.rate})`
      });
    }
  }

  // 4. Rounding rule: strictly round UP to nearest integer (Math.ceil)
  const finalCredits = Math.ceil(totalDecimal.toNumber());
  const amountString = totalDecimal.toFixed(6);

  return {
    amount: finalCredits,
    amountString,
    currency: rule.currency || "credits",
    basePrice: basePriceDecimal.toNumber(),
    modifiersApplied,
    pricingVersion: rule.pricing_version
  };
}
