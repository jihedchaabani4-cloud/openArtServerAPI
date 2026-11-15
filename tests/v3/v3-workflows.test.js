import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NodeRegistry,
  GraphCompiler,
  WorkflowExecutor,
  V3Dispatcher,
  createDefaultV3NodeRegistry,
  V3_WORKFLOWS,
  getV3Workflow,
  imageGenerationV3,
  videoGenerationV3,
  characterSheetV3,
} from "#generation/tools";

function createMockNodeExecutionContext() {
  return {
    userId: "user-v3-e2e",
    mediaRepository: {
      updateFields: async (mediaId, fields) => ({
        id: mediaId,
        ...fields,
      }),
    },
    assertOwns: async () => true,
    assertOwnsAny: async () => true,
    getMediaById: async (id) => ({
      id,
      url: `https://cdn.example.com/${id}.png`,
      width: 1024,
      height: 1024,
      status: "completed",
    }),
    getMediaUrls: async (ids) =>
      ids.map((id) => ({
        mediaId: id,
        url: `https://cdn.example.com/${id}.png`,
        status: "completed",
      })),
    getCharacterPromptContext: async ({ characterId }) => ({
      name: "Luna",
      description: "Silver-haired astronaut",
      traits: { suit: "white carbon" },
      referenceMediaUrls: [`https://cdn.example.com/${characterId}.png`],
    }),
    getElementPromptContext: async ({ elementIds }) => ({
      elements: elementIds.map((id) => ({
        id,
        name: "Solar Visor",
        description: "Reflective gold helmet visor",
        guidelines: "mirror finish",
        referenceMediaUrls: [`https://cdn.example.com/${id}.png`],
      })),
    }),
    executeLLM: async ({ prompt }) => ({
      content: `Enhanced: ${prompt}`,
      raw: `Enhanced: ${prompt}`,
      json: {
        is_safe: true,
        safety_reason: null,
        sanitized_prompt: prompt,
        description: `Enhanced: ${prompt}`,
        character_description: `Enhanced: ${prompt}`,
        prompt: `Enhanced: ${prompt}`,
      },
      model: "gemini-3.1-flash-lite",
    }),
    executeProvider: async (model, params) => ({
      assets: [
        {
          url:
            model.includes("video") || model.includes("ltx")
              ? `https://cdn.example.com/${model}-out.mp4`
              : `https://cdn.example.com/${model}-out.png`,
        },
      ],
      metadata: { model, aspect_ratio: params.aspect_ratio || "16:9" },
    }),
    attachCharacterSheetResult: async ({ characterId, mediaId, sheetUrl }) => ({
      characterId,
      primary_media_id: mediaId,
      sheet_url: sheetUrl,
    }),
  };
}

describe("V3 Declarative Workflows & #generation/tools Public Gateway", () => {
  it("exports all V3 engine classes, registries, and 3 canonical workflows from #generation/tools", () => {
    assert.ok(NodeRegistry);
    assert.ok(GraphCompiler);
    assert.ok(WorkflowExecutor);
    assert.ok(V3Dispatcher);
    assert.equal(Object.keys(V3_WORKFLOWS).length, 3);
    assert.equal(getV3Workflow("image-generation-v3"), imageGenerationV3);
    assert.equal(getV3Workflow("video-generation-v3"), videoGenerationV3);
    assert.equal(getV3Workflow("character-sheet-v3"), characterSheetV3);
  });

  it("compiles and executes imageGenerationV3 end-to-end across 4 sequential nodes", async () => {
    const reg = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(reg);

    assert.deepEqual(
      imageGenerationV3.nodes.map((n) => `${n.id}:${n.type}`),
      [
        "resolve_refs:base.resolve_references",
        "llm_process:base.llm",
        "generate_image:base.image_generate",
        "save_media:base.save_media",
      ]
    );

    const res = await executor.execute({
      workflow: imageGenerationV3,
      input: {
        prompt: "walking on Mars",
        model: "nanobana_2",
        characters: ["char-luna"],
        elements: ["elem-visor"],
        media_id: "media-img-v3",
      },
      context: createMockNodeExecutionContext(),
    });

    assert.equal(res.status, "completed");
    assert.equal(
      res.terminalOutputs.save_media.saved_media.url,
      "https://cdn.example.com/nanobana_2-out.png"
    );
    assert.equal(res.wavesExecuted, 4);
  });

  it("compiles and executes videoGenerationV3 end-to-end across 4 sequential nodes", async () => {
    const reg = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(reg);

    assert.deepEqual(
      videoGenerationV3.nodes.map((n) => `${n.id}:${n.type}`),
      [
        "resolve_refs:base.resolve_references",
        "llm_process:base.llm",
        "generate_video:base.video_generate",
        "save_media:base.save_media",
      ]
    );

    const res = await executor.execute({
      workflow: videoGenerationV3,
      input: {
        prompt: "spaceship landing in slow motion",
        model: "ltx_2_3_fast",
        duration: 8,
        media_id: "media-vid-v3",
      },
      context: createMockNodeExecutionContext(),
    });

    assert.equal(res.status, "completed");
    assert.equal(
      res.terminalOutputs.save_media.saved_media.url,
      "https://cdn.example.com/ltx_2_3_fast-out.mp4"
    );
    assert.equal(res.wavesExecuted, 4);
  });

  it("compiles and executes characterSheetV3 end-to-end across 4 sequential nodes", async () => {
    const reg = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(reg);

    assert.deepEqual(
      characterSheetV3.nodes.map((n) => `${n.id}:${n.type}`),
      [
        "resolve_refs:base.resolve_references",
        "llm_enrich:base.llm",
        "generate_sheet:base.image_generate",
        "save_sheet:custom.save_character_sheet",
      ]
    );

    const res = await executor.execute({
      workflow: characterSheetV3,
      input: {
        prompt: "Cyberpunk samurai warrior",
        character_id: "char-samurai-1",
        media_id: "media-sheet-1",
      },
      context: createMockNodeExecutionContext(),
    });

    assert.equal(res.status, "completed");
    const saved = res.terminalOutputs.save_sheet.saved_character_sheet;
    assert.equal(saved.characterId, "char-samurai-1");
    assert.equal(saved.mediaId, "media-sheet-1");
    assert.equal(saved.sheetUrl, "https://cdn.example.com/gpt-image-2-out.png");
    assert.equal(res.wavesExecuted, 4);
  });
});
