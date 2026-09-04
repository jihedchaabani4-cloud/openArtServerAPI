import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../../registry/loader.js";
import { evaluatePricing } from "../../pricing/pricingEngine.js";

test("Multi-Tier Pricing Engine: Multipliers, Per-Unit, Flat-Addon & Ceiling Rounding", async (t) => {
  loadRegistry({ strict: false });

  await t.test("Calculates base price for nanobana_pro with default 1k", () => {
    const cost = evaluatePricing("nanobana_pro", "text_to_image", {
      resolution: "1k",
      aspect_ratio: "1:1" // Neutral -> 1.0x
    });

    assert.equal(cost.basePrice, 10);
    assert.equal(cost.amount, 10);
    assert.equal(cost.currency, "credits");
    assert.equal(cost.pricingVersion, "2026-09-v1");
  });

  await t.test("Applies resolution multiplier (2k = 1.6x)", () => {
    const cost = evaluatePricing("nanobana_pro", "text_to_image", {
      resolution: "2k"
    });

    // 10 * 1.6 = 16
    assert.equal(cost.amount, 16);
    assert.equal(cost.modifiersApplied.length, 1);
    assert.equal(cost.modifiersApplied[0].param, "resolution");
    assert.equal(cost.modifiersApplied[0].impact, 1.6);
  });

  await t.test("Applies compound multiplier (2k 1.6x × hd 1.3x) + flat addon with Math.ceil", () => {
    const cost = evaluatePricing("nanobana_pro", "text_to_image", {
      resolution: "2k",
      quality: "hd",
      prompt_enhancer: "true"
    });

    // (10 * 1.6 * 1.3) + 2 = (20.8) + 2 = 22.8 -> Math.ceil -> 23 credits
    assert.equal(cost.amount, 23);
    assert.equal(cost.modifiersApplied.length, 3);
  });

  await t.test("Calculates video per-unit pricing (duration * rate * resolution multiplier)", () => {
    const cost = evaluatePricing("sora_mini", "text_to_video", {
      duration: 5,
      resolution: "1080p",
      fps: 24 // neutral (1.0x)
    });

    // base = 5s * 4 credits = 20
    // resolution = 1080p (1.5x)
    // total = 20 * 1.5 = 30 credits
    assert.equal(cost.basePrice, 20);
    assert.equal(cost.amount, 30);
  });
});
