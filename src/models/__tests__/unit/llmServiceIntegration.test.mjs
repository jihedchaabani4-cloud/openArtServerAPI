import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { llmService } from "../../../platform/ai/LLMService.js";

describe("LLMService Integration with Models Management System", () => {
  it("should generate raw text output through default Gemini 3 Flash", async () => {
    const mockSdkClient = {
      models: {
        generateContent: async ({ model, contents }) => {
          assert.equal(model, "gemini-3.6-flash");
          return {
            text: "This is a prompt enhancement from Gemini 3 Flash.",
          };
        },
      },
    };

    const response = await llmService.generate({
      prompt: "A neon cyborg warrior",
      systemInstruction: "You are an art director.",
      options: {
        sdkClient: mockSdkClient,
      },
    });

    assert.ok(response);
    assert.equal(response.raw, "This is a prompt enhancement from Gemini 3 Flash.");
    assert.equal(response.model, "gemini-3.6-flash");
  });

  it("should generate raw text output through explicit Gemini 2.0 Flash", async () => {
    const mockSdkClient = {
      models: {
        generateContent: async ({ model, contents }) => {
          assert.equal(model, "gemini-2.0-flash");
          return {
            text: "This is a prompt enhancement from Gemini 2.0 Flash.",
          };
        },
      },
    };

    const response = await llmService.generate({
      prompt: "A neon cyborg warrior",
      model: "gemini-2-0-flash",
      options: {
        sdkClient: mockSdkClient,
      },
    });

    assert.ok(response);
    assert.equal(response.raw, "This is a prompt enhancement from Gemini 2.0 Flash.");
    assert.equal(response.model, "gemini-2.0-flash");
  });

  it("should parse JSON output in jsonMode", async () => {
    const mockSdkClient = {
      models: {
        generateContent: async () => {
          return {
            text: '```json\n{"description": "Cyberpunk city", "keywords": ["neon", "rain"]}\n```',
          };
        },
      },
    };

    const response = await llmService.generate({
      prompt: "Analyze reference",
      jsonMode: true,
      options: {
        sdkClient: mockSdkClient,
      },
    });

    assert.ok(response.json);
    assert.equal(response.json.description, "Cyberpunk city");
    assert.deepEqual(response.json.keywords, ["neon", "rain"]);
  });

  it("should pass multimodal vision images array cleanly", async () => {
    let receivedPayload = null;
    const mockSdkClient = {
      models: {
        generateContent: async (payload) => {
          receivedPayload = payload;
          return {
            text: "Vision analysis complete.",
          };
        },
      },
    };

    const response = await llmService.generate({
      prompt: "Describe this character",
      images: ["https://example.com/character-view1.png", "https://example.com/character-view2.png"],
      options: {
        sdkClient: mockSdkClient,
      },
    });

    assert.ok(response);
    assert.equal(response.raw, "Vision analysis complete.");
    assert.ok(receivedPayload);
    assert.ok(Array.isArray(receivedPayload.images));
    assert.equal(receivedPayload.images.length, 2);
  });
});
