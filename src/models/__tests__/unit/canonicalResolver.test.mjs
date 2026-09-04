import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../../registry/loader.js";
import { resolveModelSchema } from "../../registry/resolver.js";
import { UnknownModelFamilyError, UnknownOperationError } from "../../errors/index.js";

test("Canonical Resolver: Loads shared parameters and resolves model schema correctly", async (t) => {
  loadRegistry({ strict: false });

  await t.test("Resolves nanobana_pro text_to_image with canonical parameters", () => {
    const schema = resolveModelSchema("nanobana_pro", "text_to_image");

    assert.equal(schema.model, "nanobana_pro");
    assert.equal(schema.operation, "text_to_image");
    assert.ok(schema.inputs.prompt);
    assert.equal(schema.inputs.prompt.type, "string");
    assert.equal(schema.inputs.prompt.required, true);
    assert.equal(schema.inputs.prompt.maxLength, 2000);

    assert.ok(schema.inputs.resolution);
    assert.equal(schema.inputs.resolution.type, "enum");
    assert.deepEqual(schema.inputs.resolution.values, ["1k", "2k", "4k"]);
    assert.equal(schema.inputs.resolution.default, "1k");

    assert.ok(schema.inputs.aspect_ratio);
    assert.equal(schema.inputs.aspect_ratio.type, "enum");
    assert.deepEqual(schema.inputs.aspect_ratio.values, ["1:1", "16:9", "9:16"]);
    assert.equal(schema.inputs.aspect_ratio.default, "1:1");

    // Video parameters must NOT exist in image model
    assert.equal(schema.inputs.duration, undefined);
    assert.equal(schema.inputs.fps, undefined);
  });

  await t.test("Resolves sora_mini text_to_video with video parameters", () => {
    const schema = resolveModelSchema("sora_mini", "text_to_video");

    assert.equal(schema.model, "sora_mini");
    assert.equal(schema.operation, "text_to_video");
    assert.ok(schema.inputs.duration);
    assert.equal(schema.inputs.duration.type, "integer");
    assert.equal(schema.inputs.duration.min, 1);
    assert.equal(schema.inputs.duration.max, 10);
    assert.equal(schema.inputs.duration.default, 5);

    assert.ok(schema.inputs.fps);
    assert.deepEqual(schema.inputs.fps.values, ["24", "60"]);
  });

  await t.test("Throws UnknownModelFamilyError for non-existent model", () => {
    assert.throws(
      () => resolveModelSchema("non_existent_model_xyz", "text_to_image"),
      UnknownModelFamilyError
    );
  });

  await t.test("Throws UnknownOperationError for unsupported operation on existing model", () => {
    assert.throws(
      () => resolveModelSchema("nanobana_pro", "audio_to_video"),
      UnknownOperationError
    );
  });
});
