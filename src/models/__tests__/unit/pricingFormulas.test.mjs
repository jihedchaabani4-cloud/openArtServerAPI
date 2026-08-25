import assert from "node:assert/strict";
import { calculateCostInternal, FORMULA_MAP } from "../../pricing/pricingFormulas.js";
import { calculateCost } from "../../pricing/modelPricingService.js";
import { loadRegistry } from "../../registry/loader.js";

loadRegistry();

console.log("Running Pricing Formulas Unit Tests for 13 Modes...");

// 1. fixed
const pFixed = calculateCostInternal({}, { mode: "fixed", amount: "5.000000" });
assert.equal(pFixed, "5.000000");

// 2. quality_table
const pQuality = calculateCostInternal({ quality: "hd" }, { mode: "quality_table", table: { standard: "4.000000", hd: "12.000000" } });
assert.equal(pQuality, "12.000000");

// 3. resolution_table
const pRes = calculateCostInternal({ resolution: "4K" }, { mode: "resolution_table", table: { "1K": "5.000000", "4K": "12.500000" } });
assert.equal(pRes, "12.500000");

// 4. matrix
const pMatrix = calculateCostInternal({ quality: "hd", resolution: "4K" }, { mode: "matrix", table: { "hd:4K": "0.720000" } });
assert.equal(pMatrix, "0.720000");

// 5. matrix_plus_extra
const pMatrixExtra = calculateCostInternal(
  { quality: "standard", resolution: "1K", count: 3 },
  { mode: "matrix_plus_extra", table: { "standard:1K": "0.400000" }, freeImages: 1, extraPerImage: "0.030000" }
);
// base 0.40 + (3 - 1) * 0.03 = 0.46
assert.equal(pMatrixExtra, "0.460000");

// 6. count_multiplier
const pCount = calculateCostInternal({ count: 4 }, { mode: "count_multiplier", baseAmount: "2.000000", table: { "4": 3.5 } });
// 2.0 * 3.5 = 7.000000
assert.equal(pCount, "7.000000");

// 7. duration_resolution_table
const pDurRes = calculateCostInternal({ durationSeconds: 10, resolution: "1080p" }, { mode: "duration_resolution_table", table: { "1080p": { "10": "30.000000" } } });
assert.equal(pDurRes, "30.000000");

// 8. per_second
const pPerSec = calculateCostInternal({ durationSeconds: 8 }, { mode: "per_second", ratePerSecond: "1.500000", baseCredits: "2.000000" });
// 2.0 + 8 * 1.5 = 14.000000
assert.equal(pPerSec, "14.000000");

// 9. per_second_with_audio_surcharge
const pAudio = calculateCostInternal({ durationSeconds: 5, audio: true }, { mode: "per_second_with_audio_surcharge", ratePerSecond: "2.000000", audioSurchargePerSecond: "0.500000" });
// 5 * (2.0 + 0.5) = 12.500000
assert.equal(pAudio, "12.500000");

// 10. scale_table
const pScale = calculateCostInternal({ scale: "4x" }, { mode: "scale_table", table: { "2x": "3.000000", "4x": "8.000000" } });
assert.equal(pScale, "8.000000");

// 11. formula (base * multipliers + additive)
const pFormula = calculateCostInternal(
  { quality: "hd", resolution: "4K", style: "photorealistic" },
  {
    mode: "formula",
    base: "10.000000",
    multipliers: { quality: { hd: 2.0, standard: 1.0 }, resolution: { "4K": 1.3, "1K": 1.0 } },
    additive: { style: { photorealistic: "0.600000" } }
  }
);
// 10.0 * 2.0 * 1.3 + 0.6 = 26.600000
assert.equal(pFormula, "26.600000");

// 12. billable_lines
const pLines = calculateCostInternal(
  { durationSeconds: 5, highFps: true },
  {
    mode: "billable_lines",
    lines: [
      { billable: "base", cost: "5.000000" },
      { billable: "duration", unitField: "durationSeconds", cost: "1.000000" },
      { billable: "fps_extra", cost: "3.000000", appliesWhen: { highFps: true } }
    ]
  }
);
// 5.0 + 5 * 1.0 + 3.0 = 13.000000
assert.equal(pLines, "13.000000");

// 13. token_based
const pTokens = calculateCostInternal(
  { inputTokens: 500_000, outputTokens: 200_000 },
  { mode: "token_based", inputRatePer1M: "2.000000", outputRatePer1M: "10.000000" }
);
// 0.5 * 2.0 + 0.2 * 10.0 = 1.0 + 2.0 = 3.000000
assert.equal(pTokens, "3.000000");

// 14. Full service calculateCost test
const cost = calculateCost("nanobana", "text_to_image", { prompt: "test", quality: "hd" });
assert.equal(cost.amount, "11.000000");
assert.equal(cost.currency, "credits");
assert.equal(cost.pricingMode, "quality_table");

console.log("✓ All 13 pricing formula modes verified!");
