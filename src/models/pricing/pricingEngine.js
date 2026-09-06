const DEFAULT_CREDIT_TO_USD_RATE = 0.15;

function resolveCreditToUsdRate(overrideRate) {
  if (typeof overrideRate === "number" && !Number.isNaN(overrideRate)) {
    return overrideRate;
  }
  const envVal = process.env.CREDIT_TO_USD_RATE;
  if (envVal !== undefined && envVal !== "" && !Number.isNaN(Number(envVal))) {
    return Number(envVal);
  }
  return DEFAULT_CREDIT_TO_USD_RATE;
}

/**
 * Pricing Engine
 *
 * Single source of truth for all pricing calculations.
 * Operates ONLY on model definitions, binding configurations, and canonical inputs.
 *
 * ── Architecture Principle (Freeze V2) ──────────────────────────────────────
 * Wholesale vs Retail Separation:
 *   - Wholesale Cost: Owned 100% by Binding (pricing.base_cost_usd + modifiers in USD).
 *   - Retail Price:   Owned primarily by Model (operations.<op>.retailPricing in Credits).
 *   - Binding Override: A Binding CAN declare its own retailPricing table if that specific
 *     provider tier carries a different user price. If present, it overrides model retailPricing.
 *
 * Financial Isolation:
 *   The pricing engine MUST NOT know about:
 *   - Users or wallets
 *   - Supabase or any DB
 *   - Hold / commit / release operations
 *
 * IMPORTANT: cost = 0 IS VALID. Never treat 0 as missing.
 * Use explicit numeric checks: typeof cost === "number" — NOT if (!cost).
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Calculates customer-facing retail credit cost.
 * Checks for a binding-level retailPricing override first; falls back to model retailPricing.
 *
 * Lookup order for `retailPricing.table`:
 *   1. Compound key:    `"${resolution}:${quality}"` (e.g. "1k:hd")
 *   2. Single dimension: `"${duration}"` or `"${resolution}"`
 *   3. Fallback:         `table.default`
 *   4. First numeric value in table
 *
 * @param {object} model       - Full model manifest (from modelRegistry)
 * @param {object} cleanInput  - Validated canonical inputs
 * @param {object} [binding]   - Optional selected binding (checks for retailPricing override)
 * @returns {number} Integer credit cost (0 is valid)
 */
export function calculateRetailCredits(model, cleanInput = {}, binding = null) {
  // 1. Check Binding/Route Override first, then fall back to Model-level retailPricing
  const retailPricing = binding?.retailPricing || model?.retailPricing || (model?.operations && Object.values(model.operations)[0]?.retailPricing);

  if (!retailPricing) {
    return 10; // Default fallback for unknown models
  }

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
 * @param {object} binding     - Selected binding manifest
 * @param {object} cleanInput   - Validated canonical inputs
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
 * Computes gross margin analytics given retail credits and wholesale cost.
 *
 * @param {number} retailCredits    - Credits charged to user
 * @param {number} wholesaleCostUsd - Provider cost in USD
 * @param {number} [creditToUsdRate] - Credit valuation rate
 * @returns {{ retailCredits, retailUsd, wholesaleCostUsd, marginUsd, marginPercent }}
 */
export function calculateMargin(retailCredits, wholesaleCostUsd, creditToUsdRate = null) {
  const rate = resolveCreditToUsdRate(creditToUsdRate);
  const retailUsd = Math.round(retailCredits * rate * 100) / 100;
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
