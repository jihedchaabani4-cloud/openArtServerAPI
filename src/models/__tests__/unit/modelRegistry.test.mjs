import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";
import os from "os";
import {
  initRegistry,
  resetRegistry,
  getRegistry,
  getModel,
  getProvider,
  getBindings,
} from "../../registry/modelRegistry.js";
import {
  UnknownProviderReferenceError,
  UnknownOperationReferenceError,
  UnknownCanonicalParameterError,
  DuplicateBindingError,
} from "../../errors/index.js";

describe("Model Registry & Fail-Fast Boot Validation", () => {
  let tempDir;

  beforeEach(() => {
    resetRegistry();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-reg-test-"));
    fs.mkdirSync(path.join(tempDir, "providers"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "shared"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "manifests"), { recursive: true });

    // Base valid provider
    fs.writeFileSync(
      path.join(tempDir, "providers", "wavespeed.json"),
      JSON.stringify({
        id: "wavespeed",
        displayName: "WaveSpeed",
        baseUrl: "https://api.wavespeed.ai",
        authType: "bearer",
        clientType: "generic-rest"
      })
    );

    // Base valid shared params
    fs.writeFileSync(
      path.join(tempDir, "shared", "image.json"),
      JSON.stringify({
        domain: "image",
        parameters: {
          prompt: { type: "string", required: true },
          resolution: { type: "string", values: ["1k", "2k", "4k"] }
        }
      })
    );
  });

  it("should initialize registry and load providers and models successfully", () => {
    // Setup model and binding
    const modelDir = path.join(tempDir, "manifests", "nanobana_pro");
    fs.mkdirSync(path.join(modelDir, "bindings"), { recursive: true });

    fs.writeFileSync(
      path.join(modelDir, "model.json"),
      JSON.stringify({
        id: "nanobana_pro",
        domain: "image",
        displayName: "NanoBanana Pro",
        operations: {
          text_to_image: {
            canonicalInputs: {
              prompt: { type: "string", required: true },
              resolution: { type: "string", values: ["1k", "2k", "4k"], default: "1k" }
            },
            retailPricing: { currency: "credits", table: { "1k": 10 } }
          }
        }
      })
    );

    fs.writeFileSync(
      path.join(modelDir, "bindings", "wavespeed.json"),
      JSON.stringify({
        modelId: "nanobana_pro",
        operation: "text_to_image",
        providerId: "wavespeed",
        providerModelId: "google/nano-banana-pro",
        endpoint: "/v1/images",
        priority: 1,
        status: "active",
        parameterMap: {
          prompt: { providerField: "prompt" },
          resolution: { providerField: "size", valueMap: { "1k": "1024x1024" } }
        },
        pricing: { base_cost_usd: 0.80 }
      })
    );

    const reg = initRegistry({ rootDir: tempDir, forceReload: true });
    assert.equal(reg.models.size, 1);
    assert.equal(reg.providers.size, 1);
    assert.equal(reg.bindings.size, 1);

    const model = getModel("nanobana_pro");
    assert.equal(model.id, "nanobana_pro");

    const provider = getProvider("wavespeed");
    assert.equal(provider.id, "wavespeed");

    const bindings = getBindings("nanobana_pro", "text_to_image");
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].providerId, "wavespeed");
  });

  it("should throw UnknownProviderReferenceError when binding references non-existent provider", () => {
    const modelDir = path.join(tempDir, "manifests", "test_model");
    fs.mkdirSync(path.join(modelDir, "bindings"), { recursive: true });

    fs.writeFileSync(
      path.join(modelDir, "model.json"),
      JSON.stringify({
        id: "test_model",
        domain: "image",
        operations: { text_to_image: { canonicalInputs: {}, retailPricing: { currency: "credits", table: {} } } }
      })
    );

    fs.writeFileSync(
      path.join(modelDir, "bindings", "ghost.json"),
      JSON.stringify({
        modelId: "test_model",
        operation: "text_to_image",
        providerId: "non_existent_provider",
        priority: 1,
        status: "active",
        pricing: { base_cost_usd: 1.0 }
      })
    );

    assert.throws(
      () => initRegistry({ rootDir: tempDir, forceReload: true }),
      UnknownProviderReferenceError
    );
  });

  it("should throw UnknownOperationReferenceError when binding references undeclared operation", () => {
    const modelDir = path.join(tempDir, "manifests", "test_model");
    fs.mkdirSync(path.join(modelDir, "bindings"), { recursive: true });

    fs.writeFileSync(
      path.join(modelDir, "model.json"),
      JSON.stringify({
        id: "test_model",
        domain: "image",
        operations: { text_to_image: { canonicalInputs: {}, retailPricing: { currency: "credits", table: {} } } }
      })
    );

    fs.writeFileSync(
      path.join(modelDir, "bindings", "wavespeed.json"),
      JSON.stringify({
        modelId: "test_model",
        operation: "unknown_operation_xyz",
        providerId: "wavespeed",
        priority: 1,
        status: "active",
        pricing: { base_cost_usd: 1.0 }
      })
    );

    assert.throws(
      () => initRegistry({ rootDir: tempDir, forceReload: true }),
      UnknownOperationReferenceError
    );
  });

  it("should throw UnknownCanonicalParameterError when binding maps unknown parameter", () => {
    const modelDir = path.join(tempDir, "manifests", "test_model");
    fs.mkdirSync(path.join(modelDir, "bindings"), { recursive: true });

    fs.writeFileSync(
      path.join(modelDir, "model.json"),
      JSON.stringify({
        id: "test_model",
        domain: "image",
        operations: {
          text_to_image: {
            canonicalInputs: { prompt: { type: "string" } },
            retailPricing: { currency: "credits", table: {} }
          }
        }
      })
    );

    fs.writeFileSync(
      path.join(modelDir, "bindings", "wavespeed.json"),
      JSON.stringify({
        modelId: "test_model",
        operation: "text_to_image",
        providerId: "wavespeed",
        priority: 1,
        status: "active",
        parameterMap: {
          non_existent_param: { providerField: "foo" }
        },
        pricing: { base_cost_usd: 1.0 }
      })
    );

    assert.throws(
      () => initRegistry({ rootDir: tempDir, forceReload: true }),
      UnknownCanonicalParameterError
    );
  });

  it("should throw DuplicateBindingError when duplicate composite key is detected", () => {
    const modelDir = path.join(tempDir, "manifests", "test_model");
    fs.mkdirSync(path.join(modelDir, "bindings"), { recursive: true });

    fs.writeFileSync(
      path.join(modelDir, "model.json"),
      JSON.stringify({
        id: "test_model",
        domain: "image",
        operations: { text_to_image: { canonicalInputs: {}, retailPricing: { currency: "credits", table: {} } } }
      })
    );

    // Binding 1
    fs.writeFileSync(
      path.join(modelDir, "bindings", "wavespeed1.json"),
      JSON.stringify({
        modelId: "test_model",
        operation: "text_to_image",
        providerId: "wavespeed",
        priority: 1,
        status: "active",
        pricing: { base_cost_usd: 1.0 }
      })
    );

    // Duplicate Binding (same modelId, operation, providerId)
    fs.writeFileSync(
      path.join(modelDir, "bindings", "wavespeed2.json"),
      JSON.stringify({
        modelId: "test_model",
        operation: "text_to_image",
        providerId: "wavespeed",
        priority: 2,
        status: "active",
        pricing: { base_cost_usd: 1.0 }
      })
    );

    assert.throws(
      () => initRegistry({ rootDir: tempDir, forceReload: true }),
      DuplicateBindingError
    );
  });
});
