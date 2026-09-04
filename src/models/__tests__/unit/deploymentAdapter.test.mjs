import test from "node:test";
import assert from "node:assert/strict";
import { resolveServableDeployment } from "../../deployment/deploymentResolver.js";
import { wavespeedImageAdapter } from "../../../adapters/wavespeedImageAdapter.js";
import { getRegistry } from "../../registry/loader.js";
import {
  ConfigIntegrityError,
  NoServableDeploymentError,
  UnknownModelFamilyError,
  ProviderMalformedResponseError,
} from "../../errors/index.js";

test("Single Active Deployment Enforcement", async (t) => {
  await t.test("Resolves single active deployment for nanobana_pro text_to_image", () => {
    const deployment = resolveServableDeployment("nanobana_pro", "text_to_image");
    assert.ok(deployment, "Should resolve active deployment");
    assert.equal(deployment.modelFamily, "nanobana_pro");
    assert.equal(deployment.provider, "wavespeed");
    assert.equal(deployment.status, "active");
  });

  await t.test("Throws UnknownModelFamilyError for non-existent model family", () => {
    assert.throws(
      () => resolveServableDeployment("non_existent_model_xyz", "text_to_image"),
      (err) => err instanceof UnknownModelFamilyError
    );
  });

  await t.test("Throws ConfigIntegrityError when multiple deployments are active for same operation", () => {
    const { deployments } = getRegistry();
    const fakeDeploymentId = "nanobana_pro.google_duplicate";
    // Inject a second active deployment
    deployments.set(fakeDeploymentId, {
      id: fakeDeploymentId,
      modelFamily: "nanobana_pro",
      provider: "google",
      status: "active",
      operations: {
        text_to_image: {
          endpoint: "/google/generate",
          outputs: { type: "image", fields: { url: { type: "string", required: true } } },
        },
      },
    });

    try {
      assert.throws(
        () => resolveServableDeployment("nanobana_pro", "text_to_image"),
        (err) => err instanceof ConfigIntegrityError && err.message.includes("Multiple servable deployments")
      );
    } finally {
      deployments.delete(fakeDeploymentId);
    }
  });
});

test("WaveSpeed Image Adapter Translation Contract", async (t) => {
  await t.test("Translates canonical resolution and aspect_ratio to WaveSpeed size and medium quality", () => {
    const canonicalInput = {
      prompt: "Cyberpunk street in rain",
      resolution: "2k",
      aspect_ratio: "16:9",
      quality: "standard",
    };

    const payload = wavespeedImageAdapter.toProviderPayload(canonicalInput, {
      endpoint: "https://api.wavespeed.ai/v1/images/generations",
    });

    assert.equal(payload.endpoint, "https://api.wavespeed.ai/v1/images/generations");
    assert.equal(payload.method, "POST");
    assert.equal(payload.body.prompt, "Cyberpunk street in rain");
    assert.equal(payload.body.size, "2048x1152");
    assert.equal(payload.body.quality, "medium");
  });

  await t.test("Translates 1k 1:1 and hd quality correctly", () => {
    const canonicalInput = {
      prompt: "Portrait photo",
      resolution: "1k",
      aspect_ratio: "1:1",
      quality: "hd",
    };

    const payload = wavespeedImageAdapter.toProviderPayload(canonicalInput);
    assert.equal(payload.body.size, "1024x1024");
    assert.equal(payload.body.quality, "high");
  });

  await t.test("Normalizes valid provider response to StandardOutput format", () => {
    const rawResponse = {
      id: "task_123",
      outputs: ["https://cdn.wavespeed.ai/images/gen_abc.png"],
    };

    const output = wavespeedImageAdapter.fromProviderResponse(rawResponse, {
      outputs: { type: "image", fields: { url: { required: true } } },
    });

    assert.equal(output.type, "image");
    assert.equal(output.url, "https://cdn.wavespeed.ai/images/gen_abc.png");
  });

  await t.test("Throws ProviderMalformedResponseError if response is not an object", () => {
    assert.throws(
      () => wavespeedImageAdapter.fromProviderResponse("plain string", { type: "image" }),
      (err) => err instanceof ProviderMalformedResponseError
    );
  });

  await t.test("Throws ProviderMalformedResponseError if required output url is missing", () => {
    assert.throws(
      () =>
        wavespeedImageAdapter.fromProviderResponse(
          { outputs: [] },
          { outputs: { type: "image", fields: { url: { required: true } } } }
        ),
      (err) => err instanceof ProviderMalformedResponseError
    );
  });
});
