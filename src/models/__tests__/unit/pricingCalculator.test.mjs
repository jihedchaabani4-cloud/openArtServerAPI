import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin
} from "../../execution/pricingCalculator.js";

describe("Pricing Calculator & Margin Analytics (US3)", () => {
  const sampleModel = {
    id: "nanobana_pro",
    operations: {
      text_to_image: {
        retailPricing: {
          currency: "credits",
          table: {
            "1k:standard": 10,
            "1k:hd": 13,
            "2k:standard": 16,
            "2k:hd": 21,
            "4k:standard": 25,
            "4k:hd": 33,
            default: 10
          }
        }
      }
    }
  };

  const sampleBindingWavespeed = {
    pricing: {
      base_cost_usd: 0.80,
      modifiers: {
        resolution: { "1k": 1.0, "2k": 1.6, "4k": 2.5 },
        quality: { standard: 1.0, hd: 1.3 }
      }
    }
  };

  const sampleBindingGoogle = {
    pricing: {
      base_cost_usd: 0.60,
      modifiers: {
        resolution: { "1k": 1.0, "2k": 1.4 },
        quality: { standard: 1.0, hd: 1.5 }
      }
    }
  };

  it("should calculate exact fixed retail credits for 1k:standard (10 credits)", () => {
    const credits = calculateRetailCredits(sampleModel, "text_to_image", {
      resolution: "1k",
      quality: "standard"
    });
    assert.equal(credits, 10);
  });

  it("should calculate exact fixed retail credits for 4k:hd (33 credits)", () => {
    const credits = calculateRetailCredits(sampleModel, "text_to_image", {
      resolution: "4k",
      quality: "hd"
    });
    assert.equal(credits, 33);
  });

  it("should compute wholesale cost for WaveSpeed 4k:standard ($2.00)", () => {
    const cost = calculateWholesaleCostUsd(sampleBindingWavespeed, {
      resolution: "4k",
      quality: "standard"
    });
    // 0.80 * 2.5 * 1.0 = 2.00
    assert.equal(Math.round(cost * 100) / 100, 2.00);
  });

  it("should compute wholesale cost for Google 2k:hd ($1.26)", () => {
    const cost = calculateWholesaleCostUsd(sampleBindingGoogle, {
      resolution: "2k",
      quality: "hd"
    });
    // 0.60 * 1.4 * 1.5 = 1.26
    assert.equal(Math.round(cost * 100) / 100, 1.26);
  });

  it("should compute margin and percentage correctly", () => {
    // 25 credits @ 0.15$ = $3.75 retail, $2.00 wholesale
    const margin = calculateMargin(25, 2.00, 0.15);
    assert.equal(margin.retailCredits, 25);
    assert.equal(margin.retailUsd, 3.75);
    assert.equal(margin.wholesaleCostUsd, 2.00);
    assert.equal(margin.marginUsd, 1.75);
    assert.equal(Math.round(margin.marginPercent * 10) / 10, 46.7);
  });
});
