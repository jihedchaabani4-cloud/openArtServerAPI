import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCanonicalInput } from "../../registry/schemaValidator.js";
import { UnknownParameterError, ValidationError, InvalidEnumValueError } from "../../errors/index.js";

describe("Schema Validator & allowUnknown Behavior (Task 13)", () => {
  const sampleCanonicalInputs = {
    prompt: { type: "string", required: true },
    resolution: { type: "string", values: ["1k", "2k", "4k"], default: "1k" },
    aspect_ratio: { type: "string", default: "1:1" },
    steps: { type: "number", default: 30 },
  };

  it("should permit framework parameters (operation, userId, idempotencyKey) without throwing when allowUnknown is false", () => {
    const rawInput = {
      prompt: "a majestic golden eagle",
      operation: "text_to_image",
      userId: "user_123",
      idempotencyKey: "node:run_1:node_1",
    };

    const clean = validateCanonicalInput(sampleCanonicalInputs, rawInput, { allowUnknown: false });

    // Canonical inputs are validated and defaults applied
    assert.equal(clean.prompt, "a majestic golden eagle");
    assert.equal(clean.resolution, "1k");
    assert.equal(clean.aspect_ratio, "1:1");
    assert.equal(clean.steps, 30);

    // Framework parameters must NOT leak into canonical cleanInput
    assert.equal(clean.operation, undefined);
    assert.equal(clean.userId, undefined);
    assert.equal(clean.idempotencyKey, undefined);
  });

  it("should reject unpermitted unknown parameters when allowUnknown is false", () => {
    const rawInput = {
      prompt: "valid prompt",
      unknown_field_xyz: "malicious_payload",
    };

    assert.throws(
      () => validateCanonicalInput(sampleCanonicalInputs, rawInput, { allowUnknown: false }),
      UnknownParameterError
    );
  });

  it("should preserve unknown parameters in output when allowUnknown is true", () => {
    const rawInput = {
      prompt: "valid prompt",
      custom_vendor_extra: "preserved_val",
      random_flag: 42,
    };

    const clean = validateCanonicalInput(sampleCanonicalInputs, rawInput, { allowUnknown: true });

    assert.equal(clean.prompt, "valid prompt");
    assert.equal(clean.resolution, "1k"); // Default applied
    assert.equal(clean.custom_vendor_extra, "preserved_val"); // Preserved
    assert.equal(clean.random_flag, 42); // Preserved
  });

  it("should enforce required parameters, enums, and type parsing", () => {
    // Missing required
    assert.throws(
      () => validateCanonicalInput(sampleCanonicalInputs, {}),
      ValidationError
    );

    // Invalid enum
    assert.throws(
      () => validateCanonicalInput(sampleCanonicalInputs, { prompt: "ok", resolution: "8k" }),
      InvalidEnumValueError
    );

    // Number type coercion
    const clean = validateCanonicalInput(sampleCanonicalInputs, { prompt: "ok", steps: "50" });
    assert.equal(clean.steps, 50);
    assert.equal(typeof clean.steps, "number");
  });
});
