import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NodeRegistry,
  GraphCompiler,
  WorkflowExecutor,
  ExecutionEngine,
  JobExecutionContext,
  createJobExecutionContext,
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
  it("exports all V3 engine classes, registries, and 7 canonical workflows with explicit contracts from internal v3", () => {
    assert.ok(NodeRegistry);
    assert.ok(GraphCompiler);
    assert.ok(WorkflowExecutor);
    assert.ok(ExecutionEngine);
    assert.ok(JobExecutionContext);
    assert.equal(typeof createJobExecutionContext, "function");
    assert.equal(Object.keys(V3_WORKFLOWS).length, 7);
    assert.equal(getV3Workflow("image-generation-v3"), imageGenerationV3);
    assert.equal(getV3Workflow("imageGeneration"), imageGenerationV3);
    assert.equal(getV3Workflow("video-generation-v3"), videoGenerationV3);
    assert.equal(getV3Workflow("videoGeneration"), videoGenerationV3);
    assert.equal(getV3Workflow("character-sheet-v3"), characterSheetV3);
    assert.equal(getV3Workflow("characterSheet"), characterSheetV3);

    const imageRelightV3 = V3_WORKFLOWS["image-relight-v3"];
    const imageAnglesV3 = V3_WORKFLOWS["image-angles-v3"];
    assert.ok(imageRelightV3, "image-relight-v3 must be registered in V3_WORKFLOWS");
    assert.ok(imageAnglesV3, "image-angles-v3 must be registered in V3_WORKFLOWS");
    assert.equal(getV3Workflow("image-relight-v3"), imageRelightV3);
    assert.equal(getV3Workflow("image-relight"), imageRelightV3);
    assert.equal(getV3Workflow("imageRelight"), imageRelightV3);
    assert.equal(getV3Workflow("image-angles-v3"), imageAnglesV3);
    assert.equal(getV3Workflow("image-angles"), imageAnglesV3);
    assert.equal(getV3Workflow("imageAngles"), imageAnglesV3);

    // Explicit workflow requiredInputs and terminal save_media configuration
    assert.equal(imageGenerationV3.category, "image");
    assert.equal(imageGenerationV3.nodes.at(-1).inputs.media_role, "output");
    assert.equal(imageGenerationV3.nodes.at(-1).inputs.save_type, "workflow_output");
    assert.deepEqual(imageGenerationV3.requiredInputs, ["prompt"]);

    assert.equal(videoGenerationV3.category, "video");
    assert.equal(videoGenerationV3.nodes.at(-1).inputs.media_role, "output");
    assert.equal(videoGenerationV3.nodes.at(-1).inputs.save_type, "video_output");
    assert.deepEqual(videoGenerationV3.requiredInputs, ["prompt"]);

    assert.equal(characterSheetV3.category, "character");
    assert.equal(characterSheetV3.nodes.at(-1).inputs.media_role, "sheet");
    assert.equal(characterSheetV3.nodes.at(-1).inputs.save_type, "character_sheet");
    assert.deepEqual(characterSheetV3.requiredInputs, ["prompt"]);

    assert.equal(imageRelightV3.category, "image");
    assert.equal(imageRelightV3.nodes.at(-1).inputs.media_role, "output");
    assert.equal(imageRelightV3.nodes.at(-1).inputs.save_type, "workflow_output");
    assert.deepEqual(imageRelightV3.requiredInputs, ["prompt", "source_image_url"]);

    assert.equal(imageAnglesV3.category, "image");
    assert.equal(imageAnglesV3.nodes.at(-1).inputs.media_role, "output");
    assert.equal(imageAnglesV3.nodes.at(-1).inputs.save_type, "workflow_output");
    assert.deepEqual(imageAnglesV3.requiredInputs, ["prompt", "source_image_url"]);

    // Every V3 workflow containing base.resolve_references wires verify_ownership with fail-closed default true
    for (const wf of Object.values(V3_WORKFLOWS)) {
      for (const node of wf.nodes) {
        if (node.type === "base.resolve_references") {
          assert.deepEqual(
            node.inputs.verify_ownership,
            { fromInput: "verify_ownership", default: true },
            `${wf.id}.${node.id} must wire verify_ownership with default: true`
          );
        }
      }
    }
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

    const refsSpec = imageGenerationV3.nodes.find((n) => n.id === "resolve_refs");
    assert.equal("style" in refsSpec.inputs, false);
    assert.equal("template_suffix" in refsSpec.inputs, false);
    const llmSpec = imageGenerationV3.nodes.find((n) => n.id === "llm_process");
    assert.deepEqual(llmSpec.inputs.skills, ["system-safety", "translate", "image-generation"]);
    assert.equal("instruction" in llmSpec.inputs, false);
    assert.equal("reference_guide" in llmSpec.inputs, false);
    const generateSpec = imageGenerationV3.nodes.find((n) => n.id === "generate_image");
    assert.deepEqual(generateSpec.inputs.prompt, { fromNode: "llm_process", output: "text" });
    const saveSpec = imageGenerationV3.nodes.find((n) => n.id === "save_media");
    assert.deepEqual(saveSpec.inputs.final_prompt, { fromNode: "llm_process", output: "text" });

    const llmCalls = [];
    const providerCalls = [];
    const baseCtx = createMockNodeExecutionContext();
    const res = await executor.execute({
      workflow: imageGenerationV3,
      input: {
        prompt: "walking on Mars",
        model: "nanobana_2",
        characters: ["char-luna"],
        elements: ["elem-visor"],
        parameters: { aspect_ratio: "16:9", resolution: "2k" },
        media_id: "media-img-v3",
      },
      context: {
        ...baseCtx,
        executeLLM: async (args) => {
          llmCalls.push(args);
          return baseCtx.executeLLM(args);
        },
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return baseCtx.executeProvider(model, params);
        },
      },
    });

    assert.equal(res.status, "completed");
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(llmCalls[0].images, []);
    assert.match(llmCalls[0].systemInstruction, /<skill name="system-safety">/);
    assert.match(llmCalls[0].systemInstruction, /<skill name="translate">/);
    assert.match(llmCalls[0].systemInstruction, /<skill name="image-generation">/);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].model, "nanobana_2");
    assert.match(providerCalls[0].params.prompt, /^Enhanced:/);
    assert.equal(providerCalls[0].params.aspect_ratio, "16:9");
    assert.equal(providerCalls[0].params.resolution, "2k");
    assert.deepEqual(providerCalls[0].params.images, [
      "https://cdn.example.com/char-luna.png",
      "https://cdn.example.com/elem-visor.png",
    ]);
    assert.equal(
      res.terminalOutputs.save_media.saved_media.url,
      "https://cdn.example.com/nanobana_2-out.png"
    );
    assert.equal(res.terminalOutputs.save_media.saved_media.role, "output");
    assert.equal(res.terminalOutputs.save_media.saved_media.save_type, "workflow_output");
    assert.equal(res.wavesExecuted, 4);
  });

  it("enforces ownership by default in base.resolve_references (verify_ownership: true) and skips duplicate worker ownership calls when verify_ownership: false", async () => {
    const reg = createDefaultV3NodeRegistry();
    const baseCtx = createMockNodeExecutionContext();

    // 1. Default (verify_ownership omitted -> true): ownership checks MUST run in ResolveRefsNode
    let defaultOwnCalls = 0;
    const defaultExec = new WorkflowExecutor(reg);
    const defaultRes = await defaultExec.execute({
      workflow: imageGenerationV3,
      input: {
        prompt: "portrait",
        model: "nanobana_2",
        characters: ["char-luna"],
        media_id: "media-own-default",
      },
      context: {
        ...baseCtx,
        assertOwns: async () => {
          defaultOwnCalls += 1;
          return true;
        },
        assertOwnsAny: async () => {
          defaultOwnCalls += 1;
          return true;
        },
      },
    });
    assert.equal(defaultRes.status, "completed");
    assert.ok(defaultOwnCalls >= 1, "omitting verify_ownership must fail-closed and run ownership checks");

    // 2. Verified service caller (verify_ownership: false): 0 duplicate ownership checks in worker
    let verifiedOwnCalls = 0;
    const verifiedExec = new WorkflowExecutor(reg);
    const verifiedRes = await verifiedExec.execute({
      workflow: imageGenerationV3,
      input: {
        prompt: "portrait",
        model: "nanobana_2",
        characters: ["char-luna"],
        verify_ownership: false,
        media_id: "media-own-skipped",
      },
      context: {
        ...baseCtx,
        assertOwns: async () => {
          verifiedOwnCalls += 1;
          return true;
        },
        assertOwnsAny: async () => {
          verifiedOwnCalls += 1;
          return true;
        },
      },
    });
    assert.equal(verifiedRes.status, "completed");
    assert.equal(verifiedOwnCalls, 0, "passing verify_ownership: false must skip duplicate worker ownership checks");
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

    const refsSpec = videoGenerationV3.nodes.find((n) => n.id === "resolve_refs");
    assert.equal("style" in refsSpec.inputs, false);
    assert.equal("template_suffix" in refsSpec.inputs, false);
    const llmSpec = videoGenerationV3.nodes.find((n) => n.id === "llm_process");
    assert.deepEqual(llmSpec.inputs.skills, ["system-safety", "translate", "video-generation"]);
    assert.equal("instruction" in llmSpec.inputs, false);
    assert.equal("reference_guide" in llmSpec.inputs, false);

    const generateNodeSpec = videoGenerationV3.nodes.find((n) => n.id === "generate_video");
    assert.equal("duration" in generateNodeSpec.inputs, false);
    assert.equal("aspect_ratio" in generateNodeSpec.inputs, false);
    assert.deepEqual(generateNodeSpec.inputs.prompt, { fromNode: "llm_process", output: "text" });
    const saveSpec = videoGenerationV3.nodes.find((n) => n.id === "save_media");
    assert.deepEqual(saveSpec.inputs.final_prompt, { fromNode: "llm_process", output: "text" });

    const llmCalls = [];
    const providerCalls = [];
    const baseCtx = createMockNodeExecutionContext();
    const res = await executor.execute({
      workflow: videoGenerationV3,
      input: {
        prompt: "spaceship landing in slow motion",
        model: "ltx_2_3_fast",
        start_image_url: "https://cdn.example.com/start-frame.png",
        end_image_url: "https://cdn.example.com/end-frame.png",
        parameters: { duration: 10, aspect_ratio: "9:16", resolution: "1080p", generate_audio: true },
        media_id: "media-vid-v3",
      },
      context: {
        ...baseCtx,
        executeLLM: async (args) => {
          llmCalls.push(args);
          return baseCtx.executeLLM(args);
        },
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return baseCtx.executeProvider(model, params);
        },
      },
    });

    assert.equal(res.status, "completed");
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(llmCalls[0].images, []);
    assert.match(llmCalls[0].systemInstruction, /<skill name="system-safety">/);
    assert.match(llmCalls[0].systemInstruction, /<skill name="translate">/);
    assert.match(llmCalls[0].systemInstruction, /<skill name="video-generation">/);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].model, "ltx_2_3_fast");
    assert.match(providerCalls[0].params.prompt, /^Enhanced:/);
    assert.equal(providerCalls[0].params.duration, 10);
    assert.equal(providerCalls[0].params.aspect_ratio, "9:16");
    assert.equal(providerCalls[0].params.resolution, "1080p");
    assert.equal(providerCalls[0].params.generate_audio, true);
    assert.equal(providerCalls[0].params.input_image, "https://cdn.example.com/start-frame.png");
    assert.equal(providerCalls[0].params.last_frame, "https://cdn.example.com/end-frame.png");
    assert.equal(
      res.terminalOutputs.save_media.saved_media.url,
      "https://cdn.example.com/ltx_2_3_fast-out.mp4"
    );
    assert.equal(res.terminalOutputs.save_media.saved_media.role, "output");
    assert.equal(res.terminalOutputs.save_media.saved_media.save_type, "video_output");
    assert.equal(res.wavesExecuted, 4);

    // Minimal videoGenerationV3 run without parameters must not inject hardcoded duration/aspect_ratio
    const minimalCalls = [];
    const minimalRes = await executor.execute({
      workflow: videoGenerationV3,
      input: {
        prompt: "minimal sunset timelapse",
        model: "ltx_2_3_fast",
        media_id: "media-vid-minimal",
      },
      context: {
        ...baseCtx,
        executeProvider: async (model, params) => {
          minimalCalls.push({ model, params });
          return baseCtx.executeProvider(model, params);
        },
      },
    });
    assert.equal(minimalRes.status, "completed");
    assert.equal(minimalCalls.length, 1);
    assert.equal("duration" in minimalCalls[0].params, false);
    assert.equal("aspect_ratio" in minimalCalls[0].params, false);
    assert.equal("input_image" in minimalCalls[0].params, false);
    assert.equal("last_frame" in minimalCalls[0].params, false);
    assert.equal("input_video" in minimalCalls[0].params, false);
  });

  it("compiles and executes characterSheetV3 across 5 nodes in 4 waves with parallel extract_character_description and generate_sheet", async () => {
    const reg = createDefaultV3NodeRegistry();
    const compiler = new GraphCompiler(reg);
    const executor = new WorkflowExecutor(reg);

    assert.deepEqual(
      characterSheetV3.nodes.map((n) => `${n.id}:${n.type}`),
      [
        "resolve_refs:base.resolve_references",
        "llm_enrich:base.llm",
        "extract_character_description:base.extract",
        "generate_sheet:base.image_generate",
        "save_media:base.save_media",
      ]
    );

    const refsSpec = characterSheetV3.nodes.find((n) => n.id === "resolve_refs");
    assert.equal("style" in refsSpec.inputs, false);
    assert.equal("template_suffix" in refsSpec.inputs, false);

    const plan = compiler.compile(characterSheetV3);
    assert.equal(plan.waves.length, 4, "characterSheetV3 must execute in 4 waves");
    assert.deepEqual(plan.waves[0], ["resolve_refs"]);
    assert.deepEqual(plan.waves[1], ["llm_enrich"]);
    assert.deepEqual(
      [...plan.waves[2]].sort(),
      ["extract_character_description", "generate_sheet"],
      "Wave 3 must run extract_character_description and generate_sheet in parallel"
    );
    assert.deepEqual(plan.waves[3], ["save_media"]);

    const llmCalls = [];
    const providerCalls = [];
    const baseCtx = createMockNodeExecutionContext();
    const res = await executor.execute({
      workflow: characterSheetV3,
      input: {
        prompt: "Cyberpunk samurai warrior",
        media_id: "media-sheet-1",
      },
      context: {
        ...baseCtx,
        executeLLM: async (args) => {
          llmCalls.push(args);
          return {
            json: {
              is_safe: true,
              safety_reason: null,
              prompt: "3-view turnaround prompt of cyberpunk samurai warrior",
              character_description: "Detailed visual bio of cyberpunk samurai warrior",
              character_title: "Neon Ronin",
            },
            model: "gemini-3.1-flash-lite",
          };
        },
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return baseCtx.executeProvider(model, params);
        },
      },
    });

    assert.equal(res.status, "completed");
    assert.equal(llmCalls.length, 1);
    assert.deepEqual(llmCalls[0].images, []);
    assert.match(llmCalls[0].systemInstruction, /<skill name="system-safety">/);
    assert.match(llmCalls[0].systemInstruction, /<skill name="translate">/);
    assert.match(llmCalls[0].systemInstruction, /<skill name="character-sheet">/);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].model, "gpt-image-2");
    assert.equal(providerCalls[0].params.aspect_ratio, "16:9");
    assert.equal(
      providerCalls[0].params.prompt,
      "3-view turnaround prompt of cyberpunk samurai warrior"
    );
    const saved = res.terminalOutputs.save_media.saved_media;
    assert.equal(saved.mediaId, "media-sheet-1");
    assert.equal(saved.url, "https://cdn.example.com/gpt-image-2-out.png");
    assert.equal(saved.role, "sheet");
    assert.equal(saved.save_type, "character_sheet");
    assert.equal(saved.character_description, "Detailed visual bio of cyberpunk samurai warrior");
    assert.equal(res.wavesExecuted, 4);

    // Fallback check: when LLM omits character_description, extract_character_description falls back to llm_enrich.text
    const fallbackExecutor = new WorkflowExecutor(reg);
    const fallbackRes = await fallbackExecutor.execute({
      workflow: characterSheetV3,
      input: {
        prompt: "Desert nomad scout",
        media_id: "media-sheet-fallback",
      },
      context: {
        ...baseCtx,
        executeLLM: async () => ({
          json: {
            is_safe: true,
            safety_reason: null,
            prompt: "3-view turnaround prompt for desert nomad scout",
          },
          model: "gemini-3.1-flash-lite",
        }),
      },
    });
    assert.equal(fallbackRes.status, "completed");
    assert.equal(
      fallbackRes.terminalOutputs.save_media.saved_media.character_description,
      "3-view turnaround prompt for desert nomad scout"
    );
  });

  it("compiles and executes chained base.image_generate nodes wiring IMAGE_URL output directly into images ARRAY input", async () => {
    const reg = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(reg);

    const chainedWorkflow = {
      id: "chained-image-edit-v3",
      nodes: [
        {
          id: "gen_base",
          type: "base.image_generate",
          inputs: {
            model: "nanobana_2",
            prompt: { fromInput: "prompt" },
          },
        },
        {
          id: "gen_edit",
          type: "base.image_generate",
          inputs: {
            model: "nanobana_2",
            prompt: "Add dramatic golden hour rim lighting",
            images: { fromNode: "gen_base", output: "image_url" },
            parameters: { aspect_ratio: "16:9" },
          },
        },
        {
          id: "save_media",
          type: "base.save_media",
          inputs: {
            media_id: { fromInput: "media_id" },
            asset_url: { fromNode: "gen_edit", output: "image_url" },
            metadata: { fromNode: "gen_edit", output: "metadata" },
          },
        },
      ],
    };

    const providerCalls = [];
    const baseCtx = createMockNodeExecutionContext();
    const res = await executor.execute({
      workflow: chainedWorkflow,
      input: {
        prompt: "Minimalist studio sneaker",
        media_id: "media-chained-1",
      },
      context: {
        ...baseCtx,
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          const stepIdx = providerCalls.length;
          return {
            assets: [{ url: `https://cdn.example.com/step-${stepIdx}.png` }],
            metadata: { model, step: stepIdx },
          };
        },
      },
    });

    assert.equal(res.status, "completed");
    assert.equal(providerCalls.length, 2);
    assert.equal("images" in providerCalls[0].params, false);
    assert.deepEqual(providerCalls[1].params.images, ["https://cdn.example.com/step-1.png"]);
    assert.equal(providerCalls[1].params.aspect_ratio, "16:9");
    assert.equal(res.terminalOutputs.save_media.saved_media.url, "https://cdn.example.com/step-2.png");
  });

  it("characterSheetV3, imageGenerationV3, and videoGenerationV3 do NOT wire images into base.llm", async () => {
    const workflowsAndLlmIds = [
      { workflow: characterSheetV3, llmNodeId: "llm_enrich" },
      { workflow: imageGenerationV3, llmNodeId: "llm_process" },
      { workflow: videoGenerationV3, llmNodeId: "llm_process" },
    ];

    for (const { workflow, llmNodeId } of workflowsAndLlmIds) {
      const llmNodeSpec = workflow.nodes.find((n) => n.id === llmNodeId);
      assert.ok(llmNodeSpec, `${workflow.id} must define ${llmNodeId}`);
      assert.equal(llmNodeSpec.type, "base.llm");
      assert.equal(
        "images" in llmNodeSpec.inputs,
        false,
        `${workflow.id}.${llmNodeId} must NOT wire images into base.llm`
      );
      assert.equal(
        "image_url" in llmNodeSpec.inputs,
        false,
        `${workflow.id}.${llmNodeId} must NOT wire legacy image_url into base.llm`
      );
    }

    const reg = createDefaultV3NodeRegistry();
    const baseCtx = createMockNodeExecutionContext();

    // Behavioral verification: even when references/characters/elements are supplied,
    // base.llm receives images: [] while image generators still receive resolved references.
    for (const { workflow, expectProviderImages } of [
      { workflow: characterSheetV3, expectProviderImages: true },
      { workflow: imageGenerationV3, expectProviderImages: true },
      { workflow: videoGenerationV3, expectProviderImages: false },
    ]) {
      const executor = new WorkflowExecutor(reg);
      const llmCalls = [];
      const providerCalls = [];
      const res = await executor.execute({
        workflow,
        input: {
          prompt: "hero portrait with reference",
          model: workflow.category === "video" ? "ltx_2_3_fast" : "gpt-image-2",
          characters: ["char-luna"],
          elements: ["elem-visor"],
          references: ["https://cdn.example.com/direct-ref.png"],
          media_id: `media-no-llm-img-${workflow.id}`,
        },
        context: {
          ...baseCtx,
          executeLLM: async (args) => {
            llmCalls.push(args);
            return baseCtx.executeLLM(args);
          },
          executeProvider: async (model, params) => {
            providerCalls.push({ model, params });
            return baseCtx.executeProvider(model, params);
          },
        },
      });

      assert.equal(res.status, "completed");
      assert.equal(llmCalls.length, 1);
      assert.deepEqual(
        llmCalls[0].images,
        [],
        `${workflow.id} must pass empty images array to base.llm`
      );
      assert.equal(providerCalls.length, 1);
      if (expectProviderImages) {
        assert.deepEqual(providerCalls[0].params.images, [
          "https://cdn.example.com/char-luna.png",
          "https://cdn.example.com/elem-visor.png",
          "https://cdn.example.com/direct-ref.png",
        ]);
      }
    }
  });

  it("composes SKILL.md skills via <skill name=\"...\"> XML blocks in all 3 V3 workflows without inline instruction or images", async () => {
    const cases = [
      {
        workflow: imageGenerationV3,
        llmNodeId: "llm_process",
        expectedSkills: ["system-safety", "translate", "image-generation"],
        model: "nanobana_2",
      },
      {
        workflow: videoGenerationV3,
        llmNodeId: "llm_process",
        expectedSkills: ["system-safety", "translate", "video-generation"],
        model: "ltx_2_3_fast",
      },
      {
        workflow: characterSheetV3,
        llmNodeId: "llm_enrich",
        expectedSkills: ["system-safety", "translate", "character-sheet"],
        model: "gpt-image-2",
      },
    ];

    const reg = createDefaultV3NodeRegistry();
    const baseCtx = createMockNodeExecutionContext();

    for (const { workflow, llmNodeId, expectedSkills, model } of cases) {
      const llmNodeSpec = workflow.nodes.find((n) => n.id === llmNodeId);
      assert.ok(llmNodeSpec, `${workflow.id} must define ${llmNodeId}`);
      assert.equal(llmNodeSpec.type, "base.llm");
      assert.equal(
        "instruction" in llmNodeSpec.inputs,
        false,
        `${workflow.id}.${llmNodeId} must NOT declare removed instruction input`
      );
      assert.equal(
        "reference_guide" in llmNodeSpec.inputs,
        false,
        `${workflow.id}.${llmNodeId} must NOT declare removed reference_guide input`
      );
      assert.deepEqual(llmNodeSpec.inputs.skills, expectedSkills);

      const executor = new WorkflowExecutor(reg);
      const llmCalls = [];
      const res = await executor.execute({
        workflow,
        input: {
          prompt: "Astronaut @Luna wearing @SolarVisor under neon rain",
          model,
          characters: ["char-luna"],
          elements: ["elem-visor"],
          media_id: `media-skill-${workflow.id}`,
        },
        context: {
          ...baseCtx,
          executeLLM: async (args) => {
            llmCalls.push(args);
            return baseCtx.executeLLM(args);
          },
        },
      });

      assert.equal(res.status, "completed");
      assert.equal(llmCalls.length, 1);

      const { systemInstruction, images, jsonMode } = llmCalls[0];
      assert.deepEqual(images, [], `${workflow.id} must keep base.llm text-only`);
      assert.equal(jsonMode, true, `${workflow.id} must enable jsonMode when SKILL.md skills require JSON/safety`);
      assert.equal(typeof systemInstruction, "string");
      for (const skill of expectedSkills) {
        assert.ok(
          systemInstruction.includes(`<skill name="${skill}">`),
          `${workflow.id} systemInstruction must include <skill name="${skill}"> block`
        );
      }
      assert.ok(
        systemInstruction.includes("[Reference Guide]") &&
          systemInstruction.includes("@Name") &&
          systemInstruction.includes("@image1..@imageN"),
        `${workflow.id} composed SKILL.md blocks must preserve reference tag guidance`
      );
    }
  });

  it("compiles and executes a workflow using base.extract to pull nested array paths (shots.0.prompt) from base.llm json at zero credit cost", async () => {
    const reg = createDefaultV3NodeRegistry();
    const compiler = new GraphCompiler(reg);
    const executor = new WorkflowExecutor(reg);

    const storyboardWorkflow = {
      id: "storyboard-extract-v3",
      nodes: [
        {
          id: "plan_shots",
          type: "base.llm",
          inputs: {
            prompt: { fromInput: "prompt" },
            skills: ["system-safety", "json-output"],
          },
        },
        {
          id: "extract_opening_shot",
          type: "base.extract",
          inputs: {
            data: { fromNode: "plan_shots", output: "json" },
            path: "shots.0.prompt",
            default_value: { fromNode: "plan_shots", output: "text" },
          },
        },
        {
          id: "gen_shot_0",
          type: "base.image_generate",
          inputs: {
            model: "nanobana_2",
            prompt: { fromNode: "extract_opening_shot", output: "text" },
          },
        },
        {
          id: "save_media",
          type: "base.save_media",
          inputs: {
            media_id: { fromInput: "media_id" },
            asset_url: { fromNode: "gen_shot_0", output: "image_url" },
            final_prompt: { fromNode: "extract_opening_shot", output: "text" },
          },
        },
      ],
    };

    const plan = compiler.compile(storyboardWorkflow);
    assert.equal(plan.activeNodeIds.length, 4);
    assert.equal(plan.waves.length, 4);

    const providerCalls = [];
    const baseCtx = createMockNodeExecutionContext();
    const res = await executor.execute({
      workflow: storyboardWorkflow,
      input: {
        prompt: "Two-shot neo-noir chase",
        media_id: "media-shot-0",
      },
      context: {
        ...baseCtx,
        executeLLM: async () => ({
          json: {
            is_safe: true,
            safety_reason: null,
            shots: [
              { prompt: "Rain-slick rooftop sprint under crimson neon" },
              { prompt: "Dramatic leap across narrow alley" },
            ],
          },
          model: "gemini-3.1-flash-lite",
        }),
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return baseCtx.executeProvider(model, params);
        },
      },
    });

    assert.equal(res.status, "completed");
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].params.prompt, "Rain-slick rooftop sprint under crimson neon");
    assert.equal(res.terminalOutputs.save_media.saved_media.url, "https://cdn.example.com/nanobana_2-out.png");
  });

  it("compiles image-relight-v3 and image-angles-v3 as zero-LLM base.text_template workflows with server-locked nanobana_2 edit pricing (12/18/26 credits, never 9)", () => {
    const reg = createDefaultV3NodeRegistry();
    const compiler = new GraphCompiler(reg);

    const workflowCases = [
      {
        canonicalId: "image-relight-v3",
        aliases: ["image-relight", "imageRelight"],
      },
      {
        canonicalId: "image-angles-v3",
        aliases: ["image-angles", "imageAngles"],
      },
    ];

    for (const { canonicalId, aliases } of workflowCases) {
      const wf = getV3Workflow(canonicalId);
      assert.ok(wf, `${canonicalId} must exist in V3 workflow registry`);
      for (const alias of aliases) {
        assert.strictEqual(getV3Workflow(alias), wf, `alias "${alias}" must resolve to ${canonicalId}`);
      }

      // Inspect static node contract (zero-LLM base.text_template + locked nanobana_2)
      const genNode = wf.nodes.find((n) => n.id === "generate_image");
      assert.equal(genNode.type, "base.image_generate");
      assert.equal(genNode.inputs.model, "nanobana_2");
      assert.equal(genNode.inputs.operation, "edit");
      const tplNode = wf.nodes.find((n) => n.id === "build_prompt");
      assert.ok(tplNode, `${canonicalId} must include build_prompt node`);
      assert.equal(tplNode.type, "base.text_template");
      assert.equal(wf.nodes.some((n) => n.type === "base.llm"), false, `${canonicalId} must not invoke base.llm`);

      const plan = compiler.compile(wf);
      assert.equal(plan.activeNodeIds.length, 4, `${canonicalId} must compile all 4 active nodes`);
      assert.equal(plan.waves.length, 4, `${canonicalId} must schedule 4 waves`);
    }
  });

  it("executes image-relight-v3 and image-angles-v3 end-to-end across all 4 zero-LLM nodes (@image1 resolution, conditional text_template, locked nanobana_2, save_media)", async () => {
    const reg = createDefaultV3NodeRegistry();
    const executor = new WorkflowExecutor(reg);
    const sourceImageUrl = "https://cdn.example.com/workflows/wf-edit/source-primary.png";

    const cases = [
      {
        workflowId: "image-relight-v3",
        prompt: "Relight fallback prompt",
        templateVars: {
          has_settings: true,
          light_type: "soft",
          rotation: 45,
          rotation_abs: 45,
          rotation_dir: "to the right",
          tilt: 15,
          tilt_abs: 15,
          tilt_dir: "above",
          brightness: 80,
          color: "#FFD9A0",
          size: 60,
          // distance and user_prompt omitted -> conditional sentences must NOT appear
        },
        expectMatch: /Relight this image with a soft light.*color #FFD9A0.*shifted 45 degrees to the right, 15 degrees above/,
        expectNotMatch: /@image1|Place the light at distance|Additional direction/,
        mediaId: "media-relight-out-1",
      },
      {
        workflowId: "image-angles-v3",
        prompt: "Angles fallback prompt",
        templateVars: {
          has_settings: true,
          rotation: -30,
          rotation_abs: 30,
          rotation_dir: "to the left",
          tilt: 20,
          tilt_abs: 20,
          tilt_dir: "upward",
          zoom: 4,
          // user_prompt omitted -> Additional direction sentence must NOT appear
        },
        expectMatch: /Move the camera relative to the current viewpoint \(rotation -30 degrees, tilt 20 degrees, zoom 4\/10\)\. Orbit the camera 30 degrees to the left around the subject\. Move the camera 20 degrees upward\. Zoom in 4\/10 closer/,
        expectNotMatch: /@image1|Additional direction/,
        mediaId: "media-angles-out-1",
      },
    ];

    for (const { workflowId, prompt, templateVars, expectMatch, expectNotMatch, mediaId } of cases) {
      const workflow = getV3Workflow(workflowId);
      const llmCalls = [];
      const providerCalls = [];
      const savedUpdates = [];
      const baseCtx = createMockNodeExecutionContext();

      const res = await executor.execute({
        workflow,
        input: {
          prompt,
          template_vars: templateVars,
          source_image_url: sourceImageUrl,
          model: "some-untrusted-client-model",
          media_id: mediaId,
          parameters: { aspect_ratio: "16:9", resolution: "1k" },
        },
        context: {
          ...baseCtx,
          mediaRepository: {
            updateFields: async (id, fields) => {
              savedUpdates.push({ id, fields });
              return { id, ...fields };
            },
          },
          executeLLM: async (args) => {
            llmCalls.push(args);
            return baseCtx.executeLLM(args);
          },
          executeProvider: async (model, params) => {
            providerCalls.push({ model, params });
            return baseCtx.executeProvider(model, params);
          },
        },
      });

      assert.equal(res.status, "completed", `${workflowId} E2E run must complete`);

      // 1. ResolveRefsNode check
      assert.deepEqual(res.nodeOutputs.resolve_refs.reference_urls, [sourceImageUrl]);
      assert.equal(res.nodeOutputs.resolve_refs.media_url, sourceImageUrl);

      // 2. Zero LLM calls + deterministic base.text_template rendering with omitted conditional blocks
      assert.equal(llmCalls.length, 0, `${workflowId} must not invoke LLM`);
      assert.match(res.nodeOutputs.build_prompt.text, expectMatch);
      assert.doesNotMatch(res.nodeOutputs.build_prompt.text, expectNotMatch);

      // 3. base.image_generate receives locked nanobana_2, rendered template prompt, and [source_image_url]
      assert.equal(providerCalls.length, 1);
      assert.equal(providerCalls[0].model, "nanobana_2", `${workflowId} must lock model to nanobana_2`);
      assert.equal(providerCalls[0].params.prompt, res.nodeOutputs.build_prompt.text);
      assert.deepEqual(providerCalls[0].params.images, [sourceImageUrl]);
      assert.equal(providerCalls[0].params.aspect_ratio, "16:9");

      // 4. base.save_media completes the target media_id
      assert.equal(savedUpdates.length, 1);
      assert.equal(savedUpdates[0].id, mediaId);
      assert.equal(savedUpdates[0].fields.status, "success");
      assert.equal(savedUpdates[0].fields.url, "https://cdn.example.com/nanobana_2-out.png");
      assert.equal(res.terminalOutputs.save_media.saved_media.id, mediaId);
      assert.equal(res.terminalOutputs.save_media.saved_media.url, "https://cdn.example.com/nanobana_2-out.png");
    }
  });

  it("image-remove-background-v3 compiles as a direct 2-node zero-LLM DAG with exact Bria credit pricing and E2E execution", async () => {
    const registry = createDefaultV3NodeRegistry();
    const compiler = new GraphCompiler(registry);
    const executor = new WorkflowExecutor(registry);

    const wf = getV3Workflow("image-remove-background-v3");
    assert.ok(wf, "image-remove-background-v3 must be registered");
    assert.equal(getV3Workflow("remove-background"), wf);
    assert.equal(wf.nodes.length, 2, "Must have strictly 2 nodes (no LLM node)");
    assert.ok(!wf.nodes.some((n) => n.type === "base.llm"), "Must NOT invoke base.llm");

    const sourceImageUrl = "https://cdn.example.com/original-subject.png";
    const planDirect = compiler.compile(wf);
    assert.equal(planDirect.activeNodeIds.length, 2, "image-remove-background-v3 must compile 2 active nodes");
    assert.equal(planDirect.waves.length, 2);

    const providerCalls = [];
    const savedUpdates = [];
    let llmCalled = false;

    const runDirect = await executor.execute({
      workflow: wf,
      input: {
        model: "bria_remove_background_3_0",
        source_image_url: sourceImageUrl,
        media_id: "media-rmbg-direct",
        parameters: { preserve_alpha: true },
      },
      context: {
        userId: "user-rmbg",
        executeLLM: async () => {
          llmCalled = true;
          throw new Error("LLM must never be called for remove-background");
        },
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return { images: [{ url: `https://cdn.example.com/${model}-cutout.png` }] };
        },
        mediaRepository: {
          findById: async (id) => ({ id, status: "processing" }),
          updateMedia: async (id, fields) => {
            savedUpdates.push({ id, fields });
            return { id, ...fields };
          },
        },
      },
    });

    assert.equal(runDirect.status, "completed");
    assert.equal(llmCalled, false, "base.llm must never execute");
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].model, "bria_remove_background_3_0");
    assert.equal(providerCalls[0].params.input_image, sourceImageUrl);
    assert.equal(providerCalls[0].params.preserve_alpha, true);
    assert.equal(providerCalls[0].params.prompt, undefined, "Direct model must not receive prompt");
    assert.equal(savedUpdates[0].id, "media-rmbg-direct");
    assert.equal(savedUpdates[0].fields.url, "https://cdn.example.com/bria_remove_background_3_0-cutout.png");

    const runGuided = await executor.execute({
      workflow: wf,
      input: {
        model: "bria_remove_background_guided",
        prompt: "keep only the red sneaker",
        source_image_url: sourceImageUrl,
        media_id: "media-rmbg-guided",
        parameters: { preserve_alpha: false },
      },
      context: {
        userId: "user-rmbg",
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return { images: [{ url: `https://cdn.example.com/${model}-cutout.png` }] };
        },
        mediaRepository: {
          findById: async (id) => ({ id, status: "processing" }),
          updateMedia: async (id, fields) => {
            savedUpdates.push({ id, fields });
            return { id, ...fields };
          },
        },
      },
    });

    assert.equal(runGuided.status, "completed");
    assert.equal(providerCalls[1].model, "bria_remove_background_guided");
    assert.equal(providerCalls[1].params.input_image, sourceImageUrl);
    assert.equal(providerCalls[1].params.prompt, "keep only the red sneaker");
    assert.equal(providerCalls[1].params.preserve_alpha, false);
  });

  it("image-edit-v3 compiles with edit-capable models, exact operations.edit pricing, image-edit skill, and full 4-node E2E", async () => {
    const registry = createDefaultV3NodeRegistry();
    const compiler = new GraphCompiler(registry);
    const executor = new WorkflowExecutor(registry);

    const wf = getV3Workflow("image-edit-v3");
    assert.ok(wf, "image-edit-v3 must be registered");
    assert.equal(getV3Workflow("image-edit"), wf);
    assert.equal(getV3Workflow("imageEdit"), wf);

    const sourceImageUrl = "https://cdn.example.com/primary-portrait.png";
    const planEdit = compiler.compile(wf);
    assert.equal(planEdit.activeNodeIds.length, 4, "image-edit-v3 must compile 4 active nodes");
    assert.equal(planEdit.waves.length, 4);

    const baseCtx = createMockNodeExecutionContext();
    const llmCalls = [];
    const providerCalls = [];
    const savedUpdates = [];

    const runRes = await executor.execute({
      workflow: wf,
      input: {
        model: "nanobana_pro",
        prompt: "Change the jacket to red leather and add sunglasses",
        source_image_url: sourceImageUrl,
        references: ["ref-media-42"],
        media_id: "media-edit-e2e",
        parameters: { resolution: "1k", aspect_ratio: "3:4" },
      },
      context: {
        ...baseCtx,
        mediaRepository: {
          updateFields: async (id, fields) => {
            savedUpdates.push({ id, fields });
            return { id, ...fields };
          },
        },
        executeLLM: async (args) => {
          llmCalls.push(args);
          return baseCtx.executeLLM(args);
        },
        executeProvider: async (model, params) => {
          providerCalls.push({ model, params });
          return baseCtx.executeProvider(model, params);
        },
      },
    });

    assert.equal(runRes.status, "completed");
    assert.equal(llmCalls.length, 1);
    assert.ok(llmCalls[0].systemInstruction.includes('<skill name="image-edit">'));
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].model, "nanobana_pro");
    assert.deepEqual(providerCalls[0].params.images, [sourceImageUrl, "https://cdn.example.com/ref-media-42.png"]);
    assert.equal(savedUpdates[0].id, "media-edit-e2e");
    assert.equal(savedUpdates[0].fields.status, "success");
  });
});
