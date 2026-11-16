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
} from "../../src/systems/generation/internal/v3/index.js";

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
  };
}

describe("V3 Declarative Workflows & Internal Engine", () => {
  it("exports all V3 engine classes, registries, and 3 canonical workflows with explicit contracts from internal v3", () => {
    assert.ok(NodeRegistry);
    assert.ok(GraphCompiler);
    assert.ok(WorkflowExecutor);
    assert.ok(V3Dispatcher);
    assert.equal(Object.keys(V3_WORKFLOWS).length, 3);
    assert.equal(getV3Workflow("image-generation-v3"), imageGenerationV3);
    assert.equal(getV3Workflow("image-generation-v1"), imageGenerationV3);
    assert.equal(getV3Workflow("imageGeneration"), imageGenerationV3);
    assert.equal(getV3Workflow("video-generation-v3"), videoGenerationV3);
    assert.equal(getV3Workflow("video-generation-v1"), videoGenerationV3);
    assert.equal(getV3Workflow("videoGeneration"), videoGenerationV3);
    assert.equal(getV3Workflow("character-sheet-v3"), characterSheetV3);
    assert.equal(getV3Workflow("character-sheet-v1"), characterSheetV3);
    assert.equal(getV3Workflow("characterSheet"), characterSheetV3);

    // Explicit workflow contracts
    assert.equal(imageGenerationV3.mediaType, "image");
    assert.equal(imageGenerationV3.mediaRole, "output");
    assert.equal(imageGenerationV3.saveType, "workflow_output");
    assert.deepEqual(imageGenerationV3.requiredInputs, ["prompt"]);

    assert.equal(videoGenerationV3.mediaType, "video");
    assert.equal(videoGenerationV3.mediaRole, "output");
    assert.equal(videoGenerationV3.saveType, "video_output");
    assert.deepEqual(videoGenerationV3.requiredInputs, ["prompt"]);

    assert.equal(characterSheetV3.mediaType, "image");
    assert.equal(characterSheetV3.mediaRole, "sheet");
    assert.equal(characterSheetV3.saveType, "character_sheet");
    assert.deepEqual(characterSheetV3.requiredInputs, ["prompt"]);
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
    assert.equal(res.terminalOutputs.save_media.saved_media.role, "output");
    assert.equal(res.terminalOutputs.save_media.saved_media.save_type, "workflow_output");
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
    assert.equal(res.terminalOutputs.save_media.saved_media.role, "output");
    assert.equal(res.terminalOutputs.save_media.saved_media.save_type, "video_output");
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
        "save_media:base.save_media",
      ]
    );

    const res = await executor.execute({
      workflow: characterSheetV3,
      input: {
        prompt: "Cyberpunk samurai warrior",
        media_id: "media-sheet-1",
      },
      context: createMockNodeExecutionContext(),
    });

    assert.equal(res.status, "completed");
    const saved = res.terminalOutputs.save_media.saved_media;
    assert.equal(saved.mediaId, "media-sheet-1");
    assert.equal(saved.url, "https://cdn.example.com/gpt-image-2-out.png");
    assert.equal(saved.role, "sheet");
    assert.equal(saved.save_type, "character_sheet");
    assert.match(saved.character_description, /Enhanced: Cyberpunk samurai warrior/);
    assert.equal(res.wavesExecuted, 4);
  });
});
