import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseApiSdk, createApiSdkClient } from "../../clients/sdk/baseApiSdk.js";
import { runWaveSpeedSdk } from "../../clients/sdk/wavespeedSdkRunner.js";
import { runGoogleSdk } from "../../clients/sdk/googleSdkRunner.js";
import { executeProviderSdk, registerProviderSdk } from "../../clients/sdk/providerSdkDispatcher.js";
import { run } from "../../execution/modelRunner.js";

describe("Provider SDK Layer & Dynamic API SDK Generator", () => {
  describe("BaseApiSdk (Fallback dynamic SDK for providers without npm package)", () => {
    it("should instantiate from provider configuration with auth headers", () => {
      const provider = {
        id: "custom_ai",
        baseUrl: "https://api.custom.ai",
        authType: "bearer",
        authHeader: "Authorization",
      };
      const sdk = createApiSdkClient(provider, "test_secret_token");
      assert.ok(sdk instanceof BaseApiSdk);
      assert.equal(sdk.baseUrl, "https://api.custom.ai");

      const headers = sdk._buildHeaders();
      assert.equal(headers["Authorization"], "Bearer test_secret_token");
      assert.equal(headers["Content-Type"], "application/json");
    });
  });

  describe("WaveSpeed Official SDK Runner", () => {
    it("should execute via WaveSpeed Client run and standardize outputs", async () => {
      let runCalledWith = null;

      const mockClient = {
        run: async (modelId, payload, config) => {
          runCalledWith = { modelId, payload, config };
          return {
            outputs: ["https://static.wavespeed.ai/output/image1.png"],
            id: "task_12345",
          };
        },
      };

      const result = await runWaveSpeedSdk({
        binding: {
          providerModelId: "bytedance/seedance-2.5/text-to-video",
        },
        payload: {
          prompt: "A neon cyberpunk cityscape at night",
          duration: 5,
        },
        credential: "dummy_wavespeed_key",
        options: {
          sdkClient: mockClient,
          pollInterval: 2.0,
          timeout: 120,
        },
      });

      assert.ok(runCalledWith);
      assert.equal(runCalledWith.modelId, "bytedance/seedance-2.5/text-to-video");
      assert.equal(runCalledWith.payload.prompt, "A neon cyberpunk cityscape at night");
      assert.equal(runCalledWith.config.pollInterval, 2.0);
      assert.equal(result.outputs[0], "https://static.wavespeed.ai/output/image1.png");
    });

    it("should map WavespeedTimeoutException to 504 ProviderTransientError", async () => {
      const mockClient = {
        run: async () => {
          const err = new Error("Task timed out after 3600s");
          err.name = "WavespeedTimeoutException";
          throw err;
        },
      };

      await assert.rejects(
        async () => {
          await runWaveSpeedSdk({
            binding: { providerModelId: "openai/gpt-image-2/text-to-image" },
            payload: { prompt: "test" },
            credential: "dummy_key",
            options: { sdkClient: mockClient },
          });
        },
        (err) => {
          assert.equal(err.statusCode, 504);
          assert.equal(err.code, "PROVIDER_TIMEOUT");
          return true;
        }
      );
    });
  });

  describe("Google GenAI SDK Runner", () => {
    it("should execute image generation via Google GenAI SDK", async () => {
      let generateImagesCalled = false;

      const mockGoogleAi = {
        models: {
          generateImages: async ({ model, prompt, config }) => {
            generateImagesCalled = true;
            assert.equal(model, "imagen-4-ultra");
            assert.equal(prompt, "A serene zen garden");
            return {
              generatedImages: [
                { imageUri: "https://google.storage/imagen-result.png" },
              ],
            };
          },
        },
      };

      const result = await runGoogleSdk({
        binding: {
          providerModelId: "imagen-4-ultra",
          operation: "text_to_image",
        },
        payload: {
          textPrompt: "A serene zen garden",
          aspectRatio: "16:9",
        },
        credential: "dummy_gemini_key",
        options: {
          sdkClient: mockGoogleAi,
        },
      });

      assert.ok(generateImagesCalled);
      assert.equal(result.images[0], "https://google.storage/imagen-result.png");
    });
  });

  describe("Provider SDK Dispatcher", () => {
    it("should route wavespeed provider to WaveSpeed SDK runner", async () => {
      let routedToWaveSpeed = false;

      const mockWavespeedClient = {
        run: async () => {
          routedToWaveSpeed = true;
          return { outputs: ["https://wavespeed.ai/result.webp"] };
        },
      };

      const result = await executeProviderSdk({
        provider: { id: "wavespeed", baseUrl: "https://api.wavespeed.ai" },
        binding: { providerModelId: "bytedance/seedream-v5.0-pro" },
        payload: { prompt: "Photorealistic portrait" },
        credential: "key_ws",
        options: {
          sdkClient: mockWavespeedClient,
        },
      });

      assert.ok(routedToWaveSpeed);
      assert.equal(result.outputs[0], "https://wavespeed.ai/result.webp");
    });

    it("should generate dynamic BaseApiSdk with API link for providers without npm SDK", async () => {
      const customProvider = {
        id: "nova_ai",
        baseUrl: "https://api.nova.ai",
        authType: "bearer",
      };

      // Mock the dynamic SDK run
      let dynamicSdkUsed = false;
      registerProviderSdk("nova_ai", async ({ provider, binding, payload }) => {
        dynamicSdkUsed = true;
        assert.equal(provider.id, "nova_ai");
        return { customResult: true, model: binding.providerModelId };
      });

      const result = await executeProviderSdk({
        provider: customProvider,
        binding: { providerModelId: "nova-video-1", endpoint: "/v1/generate" },
        payload: { prompt: "Future city" },
        credential: "nova_key",
      });

      assert.ok(dynamicSdkUsed);
      assert.equal(result.customResult, true);
    });

    it("should successfully execute end-to-end model run using SDK runner mock", async () => {
      const mockWsClient = {
        run: async (modelId, payload) => {
          return {
            outputs: ["https://api.wavespeed.ai/cdn/result-highres.png"],
          };
        },
      };

      const res = await run(
        "gpt_image_2",
        "text_to_image",
        {
          prompt: "Futuristic electric car",
          resolution: "2k",
          quality: "hd",
        },
        {
          sdkClient: mockWsClient,
          credential: "dummy_token",
        }
      );

      assert.equal(res.status, "success");
      assert.equal(res.metadata.modelId, "gpt_image_2");
      assert.equal(res.metadata.providerUsed, "wavespeed");
      assert.ok(res.metadata.creditsCharged > 0);
    });
  });
});
