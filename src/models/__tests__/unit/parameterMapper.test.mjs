import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapToProviderPayload,
  mapFromProviderResponse,
  setDeepProperty,
  getDeepProperty
} from "../../registry/parameterMapper.js";

describe("Parameter Mapper (US1)", () => {
  it("should set deep properties using dot notation", () => {
    const obj = {};
    setDeepProperty(obj, "options.dimensions.width", 1024);
    assert.deepEqual(obj, { options: { dimensions: { width: 1024 } } });
  });

  it("should get deep properties using dot notation", () => {
    const obj = { data: { output: { url: "https://example.com/img.png" } } };
    assert.equal(getDeepProperty(obj, "data.output.url"), "https://example.com/img.png");
  });

  it("should transform canonical input to WaveSpeed payload using parameterMap and valueMap", () => {
    const cleanInput = {
      prompt: "a cybernetic banana in high resolution",
      resolution: "2k",
      quality: "hd",
      aspect_ratio: "16:9"
    };

    const binding = {
      parameterMap: {
        prompt: { providerField: "prompt" },
        resolution: {
          providerField: "size",
          valueMap: { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" }
        },
        quality: {
          providerField: "quality_tier",
          valueMap: { standard: "std", hd: "high" }
        },
        aspect_ratio: { providerField: "aspect_ratio" }
      }
    };

    const payload = mapToProviderPayload(cleanInput, binding);

    assert.deepEqual(payload, {
      prompt: "a cybernetic banana in high resolution",
      size: "2048x2048",
      quality_tier: "high",
      aspect_ratio: "16:9"
    });
  });

  it("should transform canonical input to Google Imagen payload with different parameter names and types", () => {
    const cleanInput = {
      prompt: "a cybernetic banana in high resolution",
      resolution: "2k",
      quality: "hd",
      aspect_ratio: "16:9"
    };

    const binding = {
      parameterMap: {
        prompt: { providerField: "textPrompt" },
        resolution: {
          providerField: "imageSize",
          valueMap: { "1k": "small", "2k": "medium" }
        },
        quality: {
          providerField: "sampleQuality",
          valueMap: { standard: 1, hd: 2 }
        },
        aspect_ratio: { providerField: "parameters.aspectRatio" }
      }
    };

    const payload = mapToProviderPayload(cleanInput, binding);

    assert.deepEqual(payload, {
      textPrompt: "a cybernetic banana in high resolution",
      imageSize: "medium",
      sampleQuality: 2,
      parameters: {
        aspectRatio: "16:9"
      }
    });
  });

  it("should normalize provider response using outputMap", () => {
    const rawResponse = {
      predictions: [
        { imageUri: "https://storage.googleapis.com/img1.png" }
      ]
    };

    const binding = {
      outputMap: {
        "images[0].url": "predictions[0].imageUri"
      }
    };

    const output = mapFromProviderResponse(rawResponse, binding);
    assert.equal(output.images[0].url, "https://storage.googleapis.com/img1.png");
  });
});
