import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeSafetyService } from "../../src/v2/nodes/safety/NodeSafetyService.js";

describe("D2.4 — Generic Prompt Safety Ceiling (7000 chars) Boundary Tests", () => {
  it("TEST 1: assertVideoInputs and assertImageInputs accept a 3500-character expressive prompt without throwing", () => {
    const longPrompt = "A cinematic multi-shot sequence with intricate details, lighting, and camera motion. ".repeat(40);
    assert.ok(longPrompt.length > 2000 && longPrompt.length <= 7000, `Prompt length is ${longPrompt.length}`);

    // Should succeed under 7000 ceiling
    const videoResult = NodeSafetyService.assertVideoInputs({ prompt: longPrompt }, "video-generation");
    assert.equal(videoResult.prompt, longPrompt.trim());
    assert.equal(videoResult.prompt.length, longPrompt.trim().length, "Must not truncate prompt");

    const imageResult = NodeSafetyService.assertImageInputs({ prompt: longPrompt }, "image-generation");
    assert.equal(imageResult.prompt, longPrompt.trim());
    assert.equal(imageResult.prompt.length, longPrompt.trim().length, "Must not truncate prompt");
  });

  it("TEST 2: assertLLMInputs accepts a 6000-character userPrompt without throwing", () => {
    const longUserPrompt = "Detailed user instruction describing characters, scenes, and actions. ".repeat(85);
    assert.ok(longUserPrompt.length > 4000 && longUserPrompt.length <= 7000, `User prompt length is ${longUserPrompt.length}`);

    // Should succeed under 7000 ceiling
    const llmInputs = {
      userPrompt: longUserPrompt,
      skills: ["llm/translate"],
    };
    const llmResult = NodeSafetyService.assertLLMInputs(llmInputs, "llm");
    assert.equal(llmResult.userPrompt, longUserPrompt.trim());
    assert.equal(llmResult.userPrompt.length, longUserPrompt.trim().length, "Must not truncate userPrompt");
  });

  it("TEST 3: Prompts exceeding 7000 characters are strictly rejected with NODE_VALIDATION_ERROR", () => {
    const excessivePrompt = "X".repeat(7001);

    assert.throws(
      () => NodeSafetyService.assertVideoInputs({ prompt: excessivePrompt }, "video-generation"),
      (err) => {
        assert.equal(err.code, "NODE_VALIDATION_ERROR");
        assert.match(err.message, /exceeds maximum length of 7000 characters/);
        return true;
      }
    );

    assert.throws(
      () => NodeSafetyService.assertImageInputs({ prompt: excessivePrompt }, "image-generation"),
      (err) => {
        assert.equal(err.code, "NODE_VALIDATION_ERROR");
        assert.match(err.message, /exceeds maximum length of 7000 characters/);
        return true;
      }
    );

    assert.throws(
      () => NodeSafetyService.assertLLMInputs({ userPrompt: excessivePrompt, skills: ["llm/translate"] }, "llm"),
      (err) => {
        assert.equal(err.code, "NODE_VALIDATION_ERROR");
        assert.match(err.message, /exceeds maximum length of 7000 characters/);
        return true;
      }
    );
  });
});
