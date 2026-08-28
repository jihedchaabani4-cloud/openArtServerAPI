import Decimal from "decimal.js";
import { PricingConfigError } from "../errors/index.js";

// Helper: safe Decimal conversion
function toDec(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return new Decimal(fallback);
  try {
    return new Decimal(val);
  } catch {
    return new Decimal(fallback);
  }
}

export function evaluateFixed(input = {}, pricingDef = {}) {
  const amount = toDec(pricingDef.amount);
  const count = toDec(input.count || 1);
  return amount.times(count);
}

export function evaluateQualityTable(input = {}, pricingDef = {}) {
  const quality = String(input.quality || "");
  const table = pricingDef.table || {};
  const price = table[quality];
  if (price === undefined) {
    throw new PricingConfigError(`No price found for quality "${quality}" in quality_table`);
  }
  const count = toDec(input.count || 1);
  return toDec(price).times(count);
}

export function evaluateResolutionTable(input = {}, pricingDef = {}) {
  const resolution = String(input.resolution || "");
  const table = pricingDef.table || {};
  const price = table[resolution];
  if (price === undefined) {
    throw new PricingConfigError(`No price found for resolution "${resolution}" in resolution_table`);
  }
  const count = toDec(input.count || 1);
  return toDec(price).times(count);
}

export function evaluateMatrix(input = {}, pricingDef = {}) {
  const dim1Field = pricingDef.dimension1 || "quality";
  const dim2Field = pricingDef.dimension2 || "resolution";
  const val1 = String(input[dim1Field] || "");
  const val2 = String(input[dim2Field] || "");
  const key = `${val1}:${val2}`;
  const table = pricingDef.table || {};
  const price = table[key];
  if (price === undefined) {
    throw new PricingConfigError(`No matrix price found for key "${key}"`);
  }
  const count = toDec(input.count || 1);
  return toDec(price).times(count);
}

export function evaluateMatrixPlusExtra(input = {}, pricingDef = {}) {
  const basePrice = evaluateMatrix({ ...input, count: 1 }, pricingDef);
  const imageCount = toDec(input.imagesCount || input.image_count || input.count || 1);
  const freeImages = toDec(pricingDef.freeImages || 1);
  const extraPerImage = toDec(pricingDef.extraPerImage || 0);

  const billableExtra = Decimal.max(0, imageCount.minus(freeImages));
  return basePrice.plus(billableExtra.times(extraPerImage));
}

export function evaluateCountMultiplier(input = {}, pricingDef = {}) {
  const count = String(input.count || 1);
  const table = pricingDef.table || {};
  const multiplier = toDec(table[count] ?? count);
  const baseAmount = toDec(pricingDef.baseAmount || pricingDef.amount || 1);
  return baseAmount.times(multiplier);
}

export function evaluateDurationResolutionTable(input = {}, pricingDef = {}) {
  const duration = String(input.durationSeconds || input.duration || "");
  const resolution = String(input.resolution || "");
  const table = pricingDef.table || {};

  let price = table[resolution]?.[duration];
  if (price === undefined) {
    price = table[`${duration}:${resolution}`];
  }
  if (price === undefined) {
    throw new PricingConfigError(`No price found for duration "${duration}" and resolution "${resolution}" in duration_resolution_table`);
  }
  const count = toDec(input.count || 1);
  return toDec(price).times(count);
}

export function evaluatePerSecond(input = {}, pricingDef = {}) {
  const duration = toDec(input.durationSeconds || input.duration || 0);
  const ratePerSecond = toDec(pricingDef.ratePerSecond || 0);
  const baseCredits = toDec(pricingDef.baseCredits || 0);
  const count = toDec(input.count || 1);
  return baseCredits.plus(duration.times(ratePerSecond)).times(count);
}

export function evaluatePerSecondWithAudio(input = {}, pricingDef = {}) {
  const duration = toDec(input.durationSeconds || input.duration || 0);
  const ratePerSecond = toDec(pricingDef.ratePerSecond || 0);
  const audioSurcharge = input.audio || input.hasAudio ? toDec(pricingDef.audioSurchargePerSecond || 0) : new Decimal(0);
  const count = toDec(input.count || 1);
  return duration.times(ratePerSecond.plus(audioSurcharge)).times(count);
}

export function evaluateScaleTable(input = {}, pricingDef = {}) {
  const scale = String(input.scale || input.upscaleScale || input.factor || "");
  const table = pricingDef.table || {};
  const price = table[scale];
  if (price === undefined) {
    throw new PricingConfigError(`No price found for scale "${scale}" in scale_table`);
  }
  return toDec(price);
}

export function evaluateFormula(input = {}, pricingDef = {}) {
  if (pricingDef.overrides) {
    for (const [conditionKey, overridePrice] of Object.entries(pricingDef.overrides)) {
      const conditions = conditionKey.split(",").map((c) => c.trim().split("="));
      const matches = conditions.every(([k, v]) => String(input[k]) === v);
      if (matches) {
        return toDec(overridePrice);
      }
    }
  }

  let total = toDec(pricingDef.base || 0);

  if (pricingDef.multipliers) {
    for (const [dim, multiplierTable] of Object.entries(pricingDef.multipliers)) {
      const val = String(input[dim]);
      const mult = multiplierTable[val];
      if (mult !== undefined) {
        total = total.times(toDec(mult));
      }
    }
  }

  if (pricingDef.additive) {
    for (const [dim, addTable] of Object.entries(pricingDef.additive)) {
      const val = String(input[dim]);
      const add = addTable[val];
      if (add !== undefined) {
        total = total.plus(toDec(add));
      }
    }
  }

  const count = toDec(input.count || 1);
  return total.times(count);
}

export function evaluateBillableLines(input = {}, pricingDef = {}) {
  const lines = Array.isArray(pricingDef.lines) ? pricingDef.lines : [];
  let total = new Decimal(0);

  for (const line of lines) {
    let applies = true;
    if (line.appliesWhen) {
      applies = Object.entries(line.appliesWhen).every(([k, v]) => input[k] === v);
    }
    if (applies) {
      const unitCost = toDec(line.cost || 0);
      const units = line.unitField ? toDec(input[line.unitField] || 1) : new Decimal(1);
      total = total.plus(unitCost.times(units));
    }
  }
  return total;
}

export function evaluateTokenBased(inputOrUsage = {}, pricingDef = {}) {
  const inputTokens = toDec(inputOrUsage.inputTokens || inputOrUsage.promptTokens || 0);
  const outputTokens = toDec(inputOrUsage.outputTokens || inputOrUsage.completionTokens || 0);
  const inputRatePer1M = toDec(pricingDef.inputRatePer1M || 0);
  const outputRatePer1M = toDec(pricingDef.outputRatePer1M || 0);

  const inputCost = inputTokens.dividedBy(1_000_000).times(inputRatePer1M);
  const outputCost = outputTokens.dividedBy(1_000_000).times(outputRatePer1M);
  return inputCost.plus(outputCost);
}

export const FORMULA_MAP = Object.freeze({
  fixed: evaluateFixed,
  quality_table: evaluateQualityTable,
  resolution_table: evaluateResolutionTable,
  matrix: evaluateMatrix,
  matrix_plus_extra: evaluateMatrixPlusExtra,
  count_multiplier: evaluateCountMultiplier,
  duration_resolution_table: evaluateDurationResolutionTable,
  per_second: evaluatePerSecond,
  per_second_with_audio_surcharge: evaluatePerSecondWithAudio,
  scale_table: evaluateScaleTable,
  formula: evaluateFormula,
  billable_lines: evaluateBillableLines,
  token_based: evaluateTokenBased,
});

export function calculateCostInternal(cleanInputOrUsage, pricingDef) {
  const formula = FORMULA_MAP[pricingDef.mode];
  if (!formula) {
    throw new PricingConfigError(`Unknown pricing mode: "${pricingDef.mode}"`);
  }
  const resultDecimal = formula(cleanInputOrUsage, pricingDef);
  return resultDecimal.toFixed(6);
}
