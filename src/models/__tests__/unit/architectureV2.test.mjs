import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { run } from "../../execution/modelRunner.js";
import { initRegistry, resetRegistry } from "../../registry/modelRegistry.js";
import { getBindings, getBinding } from "../../registry/bindingRegistry.js";
import { selectBinding } from "../../registry/bindingSelector.js";
import { mapToProviderPayload, mapFromProviderResponse } from "../../mapping/parameterMapper.js";
import { validateOutput } from "../../mapping/outputValidator.js";
import { validateCanonicalInput } from "../../schema/schemaValidator.js";
import { evaluateRules } from "../../schema/conditionalRules.js";
import { calculateRetailCredits, calculateWholesaleCostUsd } from "../../pricing/pricingEngine.js";
import { getRunner, registerRunner, resetRuntimeRegistry } from "../../runtime/providerRuntimeRegistry.js";
import { OutputContractViolationError, ValidationError, UnknownParameterError } from "../../errors/index.js";

describe("Models Management System — Final Architecture Tests", () => {
  beforeEach(() => {
    resetRegistry();
    initRegistry({ forceReload: true });
    resetRuntimeRegistry();
  });

  describe("1. Multi-Provider per Model (nano_banana_pro on WaveSpeed and Google)", () => {
    it("should query bindings from bindingRegistry in priority order", () => {
      const bindings = getBindings("nanobana_pro", "text_to_image");
      assert.equal(bindings.length, 2);
      assert.equal(bindings[0].providerId, "wavespeed");
      assert.equal(bindings[0].priority, 1);
      assert.equal(bindings[1].providerId, "google");
      assert.equal(bindings[1].priority, 2);

      const wsBinding = getBinding("nanobana_pro", "text_to_image", "wavespeed");
      assert.ok(wsBinding);
      assert.equal(wsBinding.providerModelId, "google/nano-banana-pro/text-to-image");

      const googleBinding = getBinding("nanobana_pro", "text_to_image", "google");
      assert.ok(googleBinding);
      assert.equal(googleBinding.providerModelId, "imagen-4-ultra");
    });

    it("should map canonical inputs to distinct provider payloads for WaveSpeed vs Google", () => {
      const wsBinding = getBinding("nanobana_pro", "text_to_image", "wavespeed");
      const googleBinding = getBinding("nanobana_pro", "text_to_image", "google");

      const canonicalInput = {
        prompt: "Cinematic portrait of an astronaut",
        resolution: "2k",
        quality: "hd",
        aspect_ratio: "16:9",
      };

      // WaveSpeed mapping
      const wsPayload = mapToProviderPayload(canonicalInput, wsBinding);
      assert.equal(wsPayload.prompt, "Cinematic portrait of an astronaut");
      assert.equal(wsPayload.size, "2048x2048"); // resolution -> size: "2k" -> "2048x2048"
      assert.equal(wsPayload.quality_tier, "high"); // quality -> quality_tier: "hd" -> "high"
      assert.equal(wsPayload.aspect_ratio, "16:9");

      // Google mapping
      const googlePayload = mapToProviderPayload(canonicalInput, googleBinding);
      assert.equal(googlePayload.textPrompt, "Cinematic portrait of an astronaut"); // prompt -> textPrompt
      assert.equal(googlePayload.imageSize, "medium"); // resolution -> imageSize: "2k" -> "medium"
      assert.equal(googlePayload.sampleQuality, 2); // quality -> sampleQuality: "hd" -> 2
      assert.equal(googlePayload.aspectRatio, "16:9"); // aspect_ratio -> aspectRatio
    });

    it("should route 4k to WaveSpeed because Google binding does not support 4k", () => {
      const canonicalInput = {
        prompt: "Ultra high detail landscape",
        resolution: "4k",
        quality: "hd",
      };

      const selected = selectBinding("nanobana_pro", "text_to_image", canonicalInput);
      assert.equal(selected.providerId, "wavespeed");
    });

    it("should support preferredProvider routing to Google for 1k resolution", () => {
      const canonicalInput = {
        prompt: "A beautiful garden",
        resolution: "1k",
        quality: "standard",
      };

      const selected = selectBinding("nanobana_pro", "text_to_image", canonicalInput, {
        preferredProvider: "google",
      });
      assert.equal(selected.providerId, "google");
    });

    it("should calculate different wholesale costs for WaveSpeed vs Google for the same model", () => {
      const wsBinding = getBinding("nanobana_pro", "text_to_image", "wavespeed");
      const googleBinding = getBinding("nanobana_pro", "text_to_image", "google");

      const cleanInput = { resolution: "1k", quality: "standard" };
      const wsCost = calculateWholesaleCostUsd(wsBinding, cleanInput);
      const googleCost = calculateWholesaleCostUsd(googleBinding, cleanInput);

      assert.equal(wsCost, 0.8); // WaveSpeed base_cost_usd: 0.8
      assert.equal(googleCost, 0.6); // Google base_cost_usd: 0.6
      assert.notEqual(wsCost, googleCost);
    });

    it("should execute End-to-End run on WaveSpeed by default (priority 1)", async () => {
      let capturedPayload = null;
      const mockWsClient = {
        run: async (modelId, payload) => {
          capturedPayload = payload;
          return {
            outputs: ["https://cdn.wavespeed.ai/img/nanobana-123.png"],
          };
        },
      };

      const res = await run(
        "nanobana_pro",
        "text_to_image",
        {
          prompt: "Golden hour in Tunis",
          resolution: "2k",
          quality: "hd",
        },
        {
          userId: "usr_test",
          noCharge: true,
          sdkClient: mockWsClient,
          credential: "fake_token",
        }
      );

      assert.equal(res.status, "success");
      assert.equal(res.metadata.providerUsed, "wavespeed");
      assert.equal(res.metadata.providerModelId, "google/nano-banana-pro/text-to-image");
      assert.equal(capturedPayload.size, "2048x2048");
      assert.equal(capturedPayload.quality_tier, "high");
      assert.equal(res.images[0].url, "https://cdn.wavespeed.ai/img/nanobana-123.png");
    });

    it("should execute End-to-End run on Google when preferredProvider is specified", async () => {
      let capturedPayload = null;
      const mockGoogleClient = {
        models: {
          generateImages: async (payload) => {
            capturedPayload = payload;
            return {
              generatedImages: [
                { imageUri: "https://generativelanguage.googleapis.com/v1beta/img-456.png" },
              ],
            };
          },
        },
      };

      const res = await run(
        "nanobana_pro",
        "text_to_image",
        {
          prompt: "Golden hour in Tunis",
          resolution: "2k",
          quality: "hd",
        },
        {
          userId: "usr_test",
          noCharge: true,
          preferredProvider: "google",
          sdkClient: mockGoogleClient,
          credential: "fake_token",
        }
      );

      assert.equal(res.status, "success");
      assert.equal(res.metadata.providerUsed, "google");
      assert.equal(res.metadata.providerModelId, "imagen-4-ultra");
      assert.equal(capturedPayload.imageSize, "medium");
      assert.equal(capturedPayload.sampleQuality, 2);
      assert.equal(res.images[0].url, "https://generativelanguage.googleapis.com/v1beta/img-456.png");
    });
  });

  describe("2. Output Contract Validation (Zero Silent Failures)", () => {
    it("should throw OutputContractViolationError when image model returns no valid image URL", () => {
      const binding = { modelId: "nanobana_pro", operation: "text_to_image", providerId: "wavespeed" };

      // Case A: empty outputs
      assert.throws(
        () => validateOutput({ images: [] }, binding, "image"),
        OutputContractViolationError
      );

      // Case B: empty URL string
      assert.throws(
        () => validateOutput({ images: [{ url: "" }] }, binding, "image"),
        OutputContractViolationError
      );

      // Case C: null output
      assert.throws(
        () => validateOutput(null, binding, "image"),
        OutputContractViolationError
      );
    });

    it("should pass output validation when image model returns a valid URL", () => {
      const binding = { modelId: "nanobana_pro", operation: "text_to_image", providerId: "wavespeed" };
      assert.doesNotThrow(() =>
        validateOutput(
          { images: [{ url: "https://cdn.example.com/art.png" }] },
          binding,
          "image"
        )
      );
    });

    it("should fail-fast in modelRunner and release wallet hold on empty provider output", async () => {
      let released = false;
      const mockWallet = {
        reserve: async () => ({ reservationId: "res_contract_test" }),
        commit: async () => {},
        release: async () => {
          released = true;
        },
      };

      const mockMalformedProvider = {
        run: async () => ({ outputs: [""] }), // empty string URL -> violation!
      };

      await assert.rejects(
        () =>
          run(
            "nanobana_pro",
            "text_to_image",
            { prompt: "Test art", resolution: "1k", quality: "standard" },
            {
              userId: "usr_fail_test",
              walletService: mockWallet,
              sdkClient: mockMalformedProvider,
              credential: "fake",
            }
          ),
        OutputContractViolationError
      );

      assert.equal(released, true, "Wallet hold must be released when output contract is violated");
    });
  });

  describe("3. Conditional Rules Engine", () => {
    it("should enforce require consequence when condition is met", () => {
      const rules = [
        {
          if: { param: "aspect_ratio", eq: "custom" },
          then: { require: ["width", "height"] },
        },
      ];

      // Missing width & height with aspect_ratio: custom -> throws
      assert.throws(
        () => evaluateRules(rules, { aspect_ratio: "custom" }),
        ValidationError
      );

      // Providing width & height -> passes
      assert.doesNotThrow(() =>
        evaluateRules(rules, { aspect_ratio: "custom", width: 1024, height: 768 })
      );
    });

    it("should enforce reject consequence when forbidden parameter combination is used", () => {
      const rules = [
        {
          if: { param: "temperature", neq: 1 },
          then: { reject: "Temperature must be exactly 1 for this deterministic model" },
        },
      ];

      assert.throws(
        () => evaluateRules(rules, { temperature: 0.5 }),
        ValidationError
      );

      assert.doesNotThrow(() =>
        evaluateRules(rules, { temperature: 1 })
      );
    });

    it("should apply default values when condition is met and parameter is absent", () => {
      const rules = [
        {
          if: { param: "mode", eq: "fast" },
          then: { default: { quality: "standard", steps: 20 } },
        },
      ];

      const input = { mode: "fast" };
      evaluateRules(rules, input);
      assert.equal(input.quality, "standard");
      assert.equal(input.steps, 20);
    });
  });

  describe("4. Provider Runtime Registry", () => {
    it("should dynamically load registered runners without hardcoded if/else statements", async () => {
      const wavespeedRunner = await getRunner("wavespeed");
      assert.equal(typeof wavespeedRunner, "function");

      const googleRunner = await getRunner("google");
      assert.equal(typeof googleRunner, "function");
    });

    it("should allow manual registration of custom provider runners", async () => {
      let called = false;
      registerRunner("custom_ai", async () => {
        called = true;
        return { result: "custom_ok" };
      });

      const runner = await getRunner("custom_ai");
      const res = await runner({});
      assert.equal(called, true);
      assert.equal(res.result, "custom_ok");
    });

    it("should fallback to generic REST runner for unknown providers", async () => {
      const genericRunner = await getRunner("unregistered_new_provider");
      assert.equal(typeof genericRunner, "function");
    });
  });
});
