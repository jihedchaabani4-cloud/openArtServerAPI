import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../../registry/loader.js";
import { validateInput } from "../../validation/validationService.js";
import { UnknownParameterError, InvalidEnumValueError, ValidationError } from "../../errors/index.js";

test("Zero-Tolerance Hard Validation Pipeline", async (t) => {
  loadRegistry({ strict: false });

  await t.test("Rejects unauthorized enum values with InvalidEnumValueError", () => {
    assert.throws(
      () => {
        validateInput("nanobana_pro", "text_to_image", {
          prompt: "Futuristic city",
          resolution: "8k" // only 1k, 2k, 4k allowed
        });
      },
      (err) => {
        assert.ok(err instanceof InvalidEnumValueError);
        assert.equal(err.code, "INVALID_ENUM_VALUE");
        assert.equal(err.field, "resolution");
        return true;
      }
    );
  });

  await t.test("Rejects unknown parameters with UnknownParameterError (zero silent dropping)", () => {
    assert.throws(
      () => {
        validateInput("nanobana_pro", "text_to_image", {
          prompt: "Futuristic city",
          unknown_param_xyz: "malicious_or_accidental_value"
        });
      },
      (err) => {
        assert.ok(err instanceof UnknownParameterError);
        assert.equal(err.code, "UNKNOWN_PARAMETER");
        assert.equal(err.field, "unknown_param_xyz");
        return true;
      }
    );
  });

  await t.test("Injects schema defaults for omitted optional parameters", () => {
    const clean = validateInput("nanobana_pro", "text_to_image", {
      prompt: "Cyberpunk robot"
    });

    assert.equal(clean.prompt, "Cyberpunk robot");
    assert.equal(clean.resolution, "1k"); // default from schema
    assert.equal(clean.aspect_ratio, "1:1"); // default from schema
    assert.equal(clean.quality, "standard"); // default from schema
  });

  await t.test("Rejects prompt exceeding maxLength constraint", () => {
    const longPrompt = "a".repeat(2001);
    assert.throws(
      () => {
        validateInput("nanobana_pro", "text_to_image", {
          prompt: longPrompt
        });
      },
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.field, "prompt");
        return true;
      }
    );
  });
});
