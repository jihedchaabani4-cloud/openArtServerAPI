import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { run, calculateCost, resolveBinding } from "../../index.js";
import { initRegistry, resetRegistry } from "../../registry/modelRegistry.js";
import { resetRuntimeRegistry } from "../../runtime/providerRuntimeRegistry.js";
import {
  BindingNotFoundError,
  BindingModelMismatchError,
  UnsupportedCapabilityError,
  ConfigIntegrityError,
  OutputContractViolationError,
} from "../../errors/index.js";
import { calculateRetailCredits } from "../../pricing/pricingEngine.js";

describe("Final Models Management Architecture (Phase 1 — Explicit Binding & Financial Boundary)", () => {
  beforeEach(() => {
    resetRegistry();
    initRegistry({ forceReload: true });
    resetRuntimeRegistry();
  });

  describe("Golden Test 1: Nano Banana Pro on WaveSpeed vs Google (Phase 1 Explicit Binding)", () => {
    const canonicalInput = {
      prompt: "Cinematic portrait of a robotic tiger",
      aspect_ratio: "16:9",
      resolution: "2k",
      quality: "hd",
    };

    it("should execute on WaveSpeed when explicit bindingId is nanobana_pro.wavespeed", async () => {
      let capturedPayload = null;
      const mockWaveSpeed = {
        run: async (modelId, payload) => {
          capturedPayload = payload;
          return {
            outputs: ["https://cdn.wavespeed.ai/img/tiger_wavespeed.png"],
          };
        },
      };

      const res = await run("nanobana_pro", "text_to_image", canonicalInput, {
        bindingId: "nanobana_pro.wavespeed",
        userId: "usr_architect",
        noCharge: true,
        sdkClient: mockWaveSpeed,
        credential: "dummy_wavespeed_key",
      });

      assert.equal(res.status, "success");
      assert.equal(res.metadata.providerUsed, "wavespeed");
      assert.equal(res.metadata.providerModelId, "google/nano-banana-pro/text-to-image");

      // Verify WaveSpeed-specific translated payload
      assert.equal(capturedPayload.prompt, canonicalInput.prompt);
      assert.equal(capturedPayload.size, "2048x2048"); // 2k -> 2048x2048
      assert.equal(capturedPayload.quality_tier, "high"); // hd -> high
      assert.equal(capturedPayload.aspect_ratio, "16:9");

      // Verify canonical output shape
      assert.equal(res.images.length, 1);
      assert.equal(res.images[0].url, "https://cdn.wavespeed.ai/img/tiger_wavespeed.png");
    });

    it("should execute on Google when explicit bindingId is nanobana_pro.google with unchanged caller input", async () => {
      let capturedPayload = null;
      const mockGoogle = {
        models: {
          generateImages: async (payload) => {
            capturedPayload = payload;
            return {
              generatedImages: [
                { imageUri: "https://generativelanguage.googleapis.com/v1beta/img/tiger_google.png" },
              ],
            };
          },
        },
      };

      const res = await run("nanobana_pro", "text_to_image", canonicalInput, {
        bindingId: "nanobana_pro.google",
        userId: "usr_architect",
        noCharge: true,
        sdkClient: mockGoogle,
        credential: "dummy_google_key",
      });

      assert.equal(res.status, "success");
      assert.equal(res.metadata.providerUsed, "google");
      assert.equal(res.metadata.providerModelId, "imagen-4-ultra");

      // Verify Google-specific translated payload
      assert.equal(capturedPayload.textPrompt, canonicalInput.prompt);
      assert.equal(capturedPayload.imageSize, "medium"); // 2k -> medium
      assert.equal(capturedPayload.sampleQuality, 2); // hd -> 2
      assert.equal(capturedPayload.aspectRatio, "16:9");

      // Verify canonical output shape
      assert.equal(res.images.length, 1);
      assert.equal(res.images[0].url, "https://generativelanguage.googleapis.com/v1beta/img/tiger_google.png");
    });
  });

  describe("Golden Test 2: Explicit Failure on Provider Error (No Silent Failover)", () => {
    it("should fail immediately when chosen provider fails and NOT fallback to alternative provider", async () => {
      let googleCalled = false;

      const failingWaveSpeed = {
        run: async () => {
          const err = new Error("WaveSpeed 503 Outage");
          err.statusCode = 503;
          throw err;
        },
      };

      const mockGoogle = {
        models: {
          generateImages: async () => {
            googleCalled = true;
            return { generatedImages: [{ imageUri: "https://google.com/should_not_be_called.png" }] };
          },
        },
      };

      await assert.rejects(
        () =>
          run(
            "nanobana_pro",
            "text_to_image",
            { prompt: "Sunrise over desert" },
            {
              bindingId: "nanobana_pro.wavespeed",
              userId: "usr_test",
              noCharge: true,
              sdkClient: failingWaveSpeed,
              maxRetries: 0,
            }
          ),
        /Provider is currently unavailable|WaveSpeed 503 Outage/
      );

      // Verify Google was NEVER called as a silent failover!
      assert.equal(googleCalled, false, "Phase 1 invariant violated: system must NOT silently failover to another provider!");
    });
  });

  describe("Golden Test 3: Constraint Narrowing & Explicit Rejection", () => {
    it("should throw UnsupportedCapabilityError when binding does not support requested canonical value", async () => {
      // Google binding valueMap only supports "1k" and "2k" — it does NOT support "4k"!
      await assert.rejects(
        () =>
          run(
            "nanobana_pro",
            "text_to_image",
            { prompt: "Ultra HD wallpaper", resolution: "4k" },
            {
              bindingId: "nanobana_pro.google",
              userId: "usr_test",
              noCharge: true,
            }
          ),
        UnsupportedCapabilityError
      );
    });

    it("should allow supported values through constraint narrowing", () => {
      const binding = resolveBinding("nanobana_pro.google", "nanobana_pro", "text_to_image");
      assert.equal(binding.providerId, "google");
    });
  });

  describe("Golden Test 4: Financial Boundary (Models System Has ZERO Wallet Logic)", () => {
    it("should execute run() without requiring any wallet service or balance hold", async () => {
      const mockGoogle = {
        models: {
          generateContent: async () => ({ text: "Deterministic LLM response" }),
        },
      };

      // run() called with ZERO walletService parameter
      const res = await run(
        "gemini-3-flash",
        "chat_completion",
        { messages: [{ role: "user", content: "hello" }] },
        {
          userId: "usr_pure_model",
          noCharge: true,
          sdkClient: mockGoogle,
        }
      );

      assert.equal(res.status, "success");
      assert.equal(res.content, "Deterministic LLM response");
    });

    it("should calculate cost as a pure number without touching wallets", () => {
      const costStandard = calculateCost("nanobana_pro", "text_to_image", { resolution: "1k", quality: "standard" });
      const costHd = calculateCost("nanobana_pro", "text_to_image", { resolution: "2k", quality: "hd" });

      assert.equal(typeof costStandard, "number");
      assert.equal(costStandard, 10);
      assert.equal(typeof costHd, "number");
      assert.equal(costHd, 21);

      // LLM operation cost is 1 credit as declared in manifest
      const costLlm = calculateCost("gemini-2-0-flash", "chat_completion", {});
      assert.equal(typeof costLlm, "number");
      assert.equal(costLlm, 1);

      // Cost 0 is explicitly valid and preserved (not treated as falsy/missing)
      const freeModel = {
        id: "free_model",
        operations: {
          test_op: { retailPricing: { fixedPrice: 0 } },
        },
      };
      assert.equal(calculateRetailCredits(freeModel, "test_op", {}), 0);
    });
  });

  describe("Golden Test 5: Explicit Binding Mismatches and Integrity", () => {
    it("should throw BindingModelMismatchError when bindingId belongs to a different model", () => {
      assert.throws(
        () => resolveBinding("gemini_3_flash.google", "nanobana_pro", "text_to_image"),
        BindingModelMismatchError
      );
    });

    it("should throw BindingNotFoundError when bindingId does not exist", () => {
      assert.throws(
        () => resolveBinding("nanobana_pro.nonexistent_vendor", "nanobana_pro", "text_to_image"),
        BindingNotFoundError
      );
    });
  });
});
