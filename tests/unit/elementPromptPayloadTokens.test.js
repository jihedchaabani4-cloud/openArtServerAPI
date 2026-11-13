import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("Ticket 0.2 Unit Test: promptBuilderProService purity and ElementService token resolution", () => {
  it("promptBuilderProService.js has zero imports (pure service)", () => {
    const fileUrl = new URL("../../src/domain/element/promptBuilderProService.js", import.meta.url);
    const code = fs.readFileSync(fileUrl, "utf8");

    const hasAnyImport = /^\s*import\s+/m.test(code);
    assert.equal(hasAnyImport, false, "promptBuilderProService.js must have zero import statements");
  });

  it("exports token extraction and stripping helpers", async () => {
    const { extractElementTokens, stripElementTokens } = await import(
      "../../src/domain/element/promptBuilderProService.js"
    );

    assert.equal(typeof extractElementTokens, "function");
    assert.equal(typeof stripElementTokens, "function");

    const prompt = 'A futuristic scene with @CyberSuit and @"Neon Helmet" in a rainy city';
    const tokens = extractElementTokens(prompt);
    assert.deepEqual(tokens, ["CyberSuit", "Neon Helmet"]);

    const stripped = stripElementTokens(prompt);
    assert.equal(stripped, "A futuristic scene with and in a rainy city");
  });

  it("buildMultiElementPayload builds prompt payload correctly with plain element DTOs", async () => {
    const { default: promptBuilder } = await import(
      "../../src/domain/element/promptBuilderProService.js"
    );

    const payload = await promptBuilder.buildMultiElementPayload({
      userPrompt: "A hero standing on a rooftop @HeroCape",
      elements: [
        {
          name: "HeroCape",
          description: "A dark red flowing cape",
          reference_images: ["https://cdn.example.com/cape.png"],
          _contextNote: "Element Context (HeroCape): A dark red flowing cape",
        },
      ],
    });

    assert.ok(payload);
    assert.ok(payload.compiled_prompt.includes("HeroCape"));
    assert.ok(payload.compiled_prompt.includes("A dark red flowing cape"));
    assert.deepEqual(payload.reference_sheets, ["https://cdn.example.com/cape.png"]);
    assert.deepEqual(payload.referenceImages, ["https://cdn.example.com/cape.png"]);
    assert.equal(payload.contextNote, "Element Context (HeroCape): A dark red flowing cape");
    assert.equal(payload.scenePrompt, "A hero standing on a rooftop");
  });

  it("ElementService.buildPromptPayload resolves @tokens using instance db and getElementContextForPrompt", async () => {
    const { ElementService } = await import("../../src/domain/element/ElementService.js");

    const mockElement = {
      id: "elem-123",
      name: "SuperArmor",
      description: "Golden protective plate armor",
      workflow_id: "wf-123",
    };

    const mockMedia = [
      { id: "m-1", url: "https://cdn.example.com/armor-front.jpg" },
      { id: "m-2", url: "https://cdn.example.com/armor-back.jpg" },
    ];

    const fakeDb = {
      elements: {
        findById: async (id) => (id === mockElement.id ? mockElement : null),
        findByName: async (name) => (name.toLowerCase() === mockElement.name.toLowerCase() ? mockElement : null),
        resolveRecord: async () => mockElement,
      },
      workflows: {},
      media: {
        findByWorkflow: async (wfId) => (wfId === mockElement.workflow_id ? mockMedia : []),
      },
      workflowMedia: {},
    };

    const service = new ElementService({
      db: fakeDb,
      mediaService: {},
    });

    // Test getElementContextForPrompt directly
    const ctx = await service.getElementContextForPrompt({
      nameOrId: "SuperArmor",
      projectId: "proj-abc",
    });
    assert.ok(ctx);
    assert.equal(ctx.name, "SuperArmor");
    assert.equal(ctx.description, "Golden protective plate armor");
    assert.deepEqual(ctx.referenceImageUrls, [
      "https://cdn.example.com/armor-front.jpg",
      "https://cdn.example.com/armor-back.jpg",
    ]);

    // Test buildPromptPayload which resolves @SuperArmor token
    const result = await service.buildPromptPayload({
      userPrompt: "Warrior wearing @SuperArmor ready for battle",
      projectId: "proj-abc",
    });

    assert.ok(result);
    assert.ok(result.compiled_prompt.includes("SuperArmor"));
    assert.ok(result.compiled_prompt.includes("Golden protective plate armor"));
    assert.deepEqual(result.reference_sheets, [
      "https://cdn.example.com/armor-front.jpg",
      "https://cdn.example.com/armor-back.jpg",
    ]);
    assert.equal(result.scenePrompt, "Warrior wearing ready for battle");
  });
});
