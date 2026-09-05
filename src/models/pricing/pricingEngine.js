import { getCreditToUsdRate } from "../../config/billing.js";

/**
 * Pricing Engine
 *
 * Single source of truth for all pricing calculations.
 * Operates ONLY on model definitions, binding configurations, and canonical inputs.
 *
 * ── Architecture Principle ─────────────────────────────────────────────────
 * The pricing engine MUST NOT know about:
 *   - Users or wallets
 *   - Supabase or any DB
 *   - Hold / commit / release operations
 *   - Any payment gateway
 *
 * Responsibility: given Model + Operation + Inputs → return a Number.
 * Financial operations stay in the Wallet/Billing layer.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * IMPORTANT: cost = 0 IS VALID. Never treat 0 as missing.
 * Use explicit numeric checks: typeof cost === "number" — NOT if (!cost).
 */

/**
 * Calculates customer-facing retail credit cost.
 *
 * Lookup order for `retailPricing.table`:
 *   1. Compound key:    `"${resolution}:${quality}"` (e.g. "1k:hd")
 *   2. Single dimension: `"${duration}"` or `"${resolution}"`
 *   3. Fallback:         `table.default`
 *   4. First numeric value in table
 *
 * @param {object} model     - Full model manifest (from modelRegistry)
 * @param {string} operation - Operation name (e.g. "text_to_image")
 * @param {object} cleanInput - Validated canonical inputs
 * @returns {number} Integer credit cost (0 is valid)
 */
export function calculateRetailCredits(model, operation, cleanInput = {}) {
  if (!model || !model.operations || !model.operations[operation]) {
    return 10; // Default fallback for unknown models
  }

  const opDef = model.operations[operation];
  const retailPricing = opDef.retailPricing;
  if (!retailPricing) return 10;

  // Fixed price (e.g. free LLM platform calls)
  if (typeof retailPricing.fixedPrice === "number") {
    return retailPricing.fixedPrice;
  }

  if (retailPricing.table) {
    const table = retailPricing.table;

    // 1. Compound key: resolution + quality (image models)
    const resolution = cleanInput.resolution;
    const quality = cleanInput.quality;

    if (resolution && quality) {
      const compoundKey = `${resolution}:${quality}`;
      if (Object.prototype.hasOwnProperty.call(table, compoundKey)) {
        return table[compoundKey];
      }
    }

    // 2. Single key — resolution tier (image) or duration (video)
    const lookupKey = resolution ?? cleanInput.duration;
    if (lookupKey !== undefined && Object.prototype.hasOwnProperty.call(table, String(lookupKey))) {
      return table[String(lookupKey)];
    }

    // 3. table.default fallback
    if (table.default !== undefined) {
      return table.default;
    }

    // 4. First numeric value in table as last resort
    const firstKey = Object.keys(table).find((k) => typeof table[k] === "number");
    if (firstKey) return table[firstKey];
  }

  return 10;
}

/**
 * Calculates internal wholesale cost in USD from binding.pricing.
 * Used for margin analytics — NOT for user billing.
 *
 * @param {object} binding   - Selected binding manifest
 * @param {object} cleanInput - Validated canonical inputs
 * @returns {number} Wholesale cost in USD (0 = free/internal)
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
 * Computes gross margin analytics.
 *
 * @param {number} retailCredits    - Credits charged to user
 * @param {number} wholesaleCostUsd - Provider cost in USD
 * @param {number} [creditToUsdRate] - Credit valuation rate
 * @returns {{ retailCredits, retailUsd, wholesaleCostUsd, marginUsd, marginPercent }}
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE NOTE — Future Token-Based Billing:
 * Currently, all models use fixed retail pricing evaluated deterministically upfront.
 *
 * Any future dynamic token-based billing requires:
 * 1. Two-Phase Wallet Hold: upfront hold at maxTokens budget
 * 2. Partial Commit: settle final amount < held amount (refund delta)
 * 3. Provider Token Reporting: extract usage.prompt_tokens + usage.completion_tokens
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
