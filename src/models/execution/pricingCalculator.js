import { getCreditToUsdRate } from "../../config/billing.js";

/**
 * Fixed Retail Pricing Evaluator & Wholesale Margin Calculator
 */

/**
 * Calculates customer-facing credit cost from model.json retailPricing.
 */
export function calculateRetailCredits(model, operation, cleanInput = {}) {
  if (!model || !model.operations || !model.operations[operation]) {
    return 10; // Default fallback
  }

  const opDef = model.operations[operation];
  const retailPricing = opDef.retailPricing;
  if (!retailPricing) return 10;

  if (typeof retailPricing.fixedPrice === "number") {
    return retailPricing.fixedPrice;
  }

  if (retailPricing.table) {
    const table = retailPricing.table;

    // 1. Try compound keys (e.g. "resolution:quality" -> "4k:hd")
    const resolution = cleanInput.resolution;
    const quality = cleanInput.quality;

    if (resolution && quality) {
      const compoundKey = `${resolution}:${quality}`;
      if (Object.prototype.hasOwnProperty.call(table, compoundKey)) {
        return table[compoundKey];
      }
    }

    // 2. Try single resolution key
    if (resolution && Object.prototype.hasOwnProperty.call(table, resolution)) {
      return table[resolution];
    }

    // 3. Try fallback default
    if (table.default !== undefined) {
      return table.default;
    }

    // 4. Return first key value
    const firstKey = Object.keys(table)[0];
    if (firstKey && typeof table[firstKey] === "number") {
      return table[firstKey];
    }
  }

  return 10;
}

/**
 * Calculates internal wholesale cost in USD from binding.pricing.
 */
export function calculateWholesaleCostUsd(binding, cleanInput = {}) {
  if (!binding || !binding.pricing) return 0;

  const pricing = binding.pricing;
  let cost = pricing.base_cost_usd || 0;

  if (pricing.modifiers) {
    for (const [paramKey, modifierTable] of Object.entries(pricing.modifiers)) {
      const paramVal = cleanInput[paramKey];
      if (paramVal !== undefined && modifierTable[paramVal] !== undefined) {
        cost *= modifierTable[paramVal];
      }
    }
  }

  return Math.round(cost * 10000) / 10000;
}

/**
 * Computes margin and analytics given retail credits and wholesale cost.
 *
 * @param {number} retailCredits - Fixed customer credits charged
 * @param {number} wholesaleCostUsd - Real provider wholesale cost in USD
 * @param {number} [creditToUsdRate] - Valuation rate from central billing config
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE NOTE (Task 14 — LLM Token-Based Billing Evolution):
 * Currently, all models (including LLMs) use fixed retail pricing (fixedPrice or table)
 * evaluated deterministically upfront.
 *
 * Any future transition to dynamic token-based billing (e.g., charging per input
 * prompt token and generated output token) will require:
 * 1. Two-Phase Wallet Hold: An upfront hold representing the maximum allowable budget
 *    (e.g., maxTokens limit).
 * 2. Partial Commit: walletService.commit(reservationId, { creditsCharged }) must
 *    support settling a final amount LESS than the held amount, immediately refunding
 *    the difference to the user's available balance.
 * 3. Provider Token Reporting: Extracting usage metadata (prompt_tokens, completion_tokens)
 *    from provider responses to calculate the exact post-generation cost.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function calculateMargin(retailCredits, wholesaleCostUsd, creditToUsdRate = getCreditToUsdRate()) {
  const retailUsd = Math.round(retailCredits * creditToUsdRate * 100) / 100;
  const marginUsd = Math.round((retailUsd - wholesaleCostUsd) * 100) / 100;
  const marginPercent = retailUsd > 0 ? Math.round((marginUsd / retailUsd) * 1000) / 10 : 0;

  return {
    retailCredits,
    retailUsd,
    wholesaleCostUsd,
    marginUsd,
    marginPercent,
  };
}
