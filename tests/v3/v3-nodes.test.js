import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultV3NodeRegistry,
  V3_BASE_NODES,
  V3_CUSTOM_NODES,
  ResolveRefsNode,
  LlmNode,
  LLM_SKILLS_REGISTRY,
  ImageGenerateNode,
  VideoGenerateNode,
  SaveMediaNode,
  SaveCharacterSheetNode,
} from "../../src/systems/generation/internal/v3/nodes/index.js";

describe("V3 Base & Custom Nodes Suite", () => {
  it("registers the 5 pure base.* nodes and 1 custom.* node into a frozen registry", () => {
    const reg = createDefaultV3NodeRegistry();
    assert.equal(reg.isFrozen(), true);
    assert.equal(V3_BASE_NODES.length, 5);
    assert.equal(V3_CUSTOM_NODES.length, 1);
    assert.equal(reg.list().length, 6);
    assert.equal(reg.has("base.resolve_references"), true);
    assert.equal(reg.has("base.llm"), true);
    assert.equal(reg.has("base.image_generate"), true);
    assert.equal(reg.has("base.video_generate"), true);
    assert.equal(reg.has("base.save_media"), true);
    assert.equal(reg.has("custom.save_character_sheet"), true);
    assert.equal(reg.get("base.save_media").OUTPUT_NODE, true);
    assert.equal(reg.get("custom.save_character_sheet").OUTPUT_NODE, true);
  });

  it("base.resolve_references verifies ownership, resolves media/characters/elements, replaces inline tags, and builds [Reference Guide]", async () => {
    const ownershipChecks = [];
    const out = await ResolveRefsNode.execute(
      {
        prompt: "A scene with <character:char-1> wearing <element:elem-1> at night",
        style: "cinematic noir",
        media_id: "media-123",
        characters: ["char-1"],
        elements: ["elem-1"],
        references: ["https://cdn.example.com/ref-direct.png", "media-99"],
        verify_ownership: true,
      },
      {
        userId: "user-1",
        assertOwnsAny: async (types, id, uid) => {
          ownershipChecks.push({ types, id, uid });
          return true;
        },
        getMediaById: async (id) => ({
          id,
          url: `https://cdn.example.com/${id}.png`,
          width: 1024,
          height: 1024,
          status: "completed",
        }),
        getCharacterPromptContext: async ({ characterId }) => ({
          name: "Aria",
          description: "Cyberpunk hacker",
          traits: { hair: "silver" },
          referenceMediaUrls: [`https://cdn.example.com/${characterId}.png`],
        }),
        getElementPromptContext: async () => ({
          elements: [
            {
              id: "elem-1",
              name: "Neon Jacket",
              description: "Glowing collar",
              guidelines: "high contrast",
              referenceMediaUrls: ["https://cdn.example.com/elem-1.png"],
            },
          ],
        }),
        getMediaUrls: async () => [
          {
            mediaId: "media-99",
            url: "https://cdn.example.com/media-99.png",
          },
        ],
      }
    );

    assert.ok(ownershipChecks.length >= 3);
    assert.equal(out.media_url, "https://cdn.example.com/media-123.png");
    assert.equal(out.reference_urls.length, 5);
    assert.match(out.prepared_prompt, /@Aria/);
    assert.match(out.prepared_prompt, /@Neon Jacket/);
    assert.ok(!out.prepared_prompt.includes("<character:char-1>"));
    assert.ok(!out.prepared_prompt.includes("<element:elem-1>"));
    assert.match(out.reference_guide, /\[Reference Guide\]/);
    assert.match(out.reference_guide, /@image1/);
    assert.equal(out.entities_context.resolvedCount, 5);
  });

  it("base.llm executes single-call skills (system-safety, translate, character-description) and fails closed on safety or schema violations", async () => {
    assert.ok(LLM_SKILLS_REGISTRY["system-safety"]);
    assert.ok(LLM_SKILLS_REGISTRY.translate);
    assert.ok(LLM_SKILLS_REGISTRY.translation);
    assert.ok(LLM_SKILLS_REGISTRY["character-description"]);
    assert.ok(LLM_SKILLS_REGISTRY["json-output"]);

    let capturedCall = null;
    const ok = await LlmNode.execute(
      {
        prompt: "@Aria قطوس في الفضاء\n\n[Reference Guide]\n@Aria (character)\n  visual references: @image1",
        reference_guide: "[Reference Guide]\n@Aria (character)\n  visual references: @image1",
        images: ["https://cdn.example.com/char-1.png"],
        skills: ["system-safety", "translation", "character-description"],
        custom_instruction: "Keep lighting dramatic",
      },
      {
        userId: "user-1",
        executeLLM: async (args) => {
          capturedCall = args;
          return {
            json: {
              is_safe: true,
              safety_reason: null,
              prompt: "@Aria cat in space with @image1",
              character_description: "Full body 3-view turnaround of @Aria",
              character_title: "Space Cat Aria",
            },
            model: "gemini-3.1-flash-lite",
          };
        },
      }
    );

    assert.ok(capturedCall, "Single executeLLM call must be made");
    assert.equal(capturedCall.images.length, 1);
    assert.match(capturedCall.systemInstruction, /SAFETY GUARD/);
    assert.match(capturedCall.systemInstruction, /FAITHFUL TRANSLATION/);
    assert.match(capturedCall.systemInstruction, /CHARACTER TURNAROUND SHEET/);
    assert.match(capturedCall.systemInstruction, /Keep lighting dramatic/);

    assert.equal(ok.is_safe, true);
    assert.match(ok.final_prompt, /@Aria cat in space with @image1/);
    assert.match(ok.final_prompt, /\[Reference Guide\]/);
    assert.equal(ok.character_description, "Full body 3-view turnaround of @Aria");
    assert.equal(ok.character_title, "Space Cat Aria");

    await assert.rejects(
      () =>
        LlmNode.execute(
          {
            prompt: "prohibited nsfw prompt",
            skills: ["system-safety", "translate"],
          },
          {
            executeLLM: async () => ({
              json: {
                is_safe: false,
                safety_reason: "NSFW content detected",
              },
            }),
          }
        ),
      (err) => {
        assert.equal(err.code, "CONTENT_SAFETY_VIOLATION");
        assert.equal(err.is_safe, false);
        assert.match(err.message, /NSFW content detected/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        LlmNode.execute(
          {
            prompt: "test fail closed",
            skills: ["system-safety"],
          },
          {
            executeLLM: async () => ({ json: null }),
          }
        ),
      /fail-closed/
    );
  });

  it("base.image_generate and base.video_generate execute cleanly", async () => {
    const imgGen = await ImageGenerateNode.execute(
      { model: "flux-schnell", prompt: "neon city" },
      {
        executeProvider: async (model, params) => ({
          assets: [{ url: `https://cdn.example.com/${model}.png` }],
          metadata: { aspect_ratio: params.aspect_ratio },
        }),
      }
    );
    assert.equal(imgGen.image_url, "https://cdn.example.com/flux-schnell.png");

    const vidGen = await VideoGenerateNode.execute(
      {
        model: "kling-v1.6",
        prompt: "camera pans left",
        start_image_url: imgGen.image_url,
        duration: 5,
      },
      {
        executeProvider: async () => ({
          assets: [{ url: "https://cdn.example.com/video.mp4" }],
        }),
      }
    );
    assert.equal(vidGen.video_url, "https://cdn.example.com/video.mp4");
  });

  it("enforces fail-closed pricing via real #models/tools calculateCost and throws on unknown models", () => {
    const imgCost = ImageGenerateNode.estimateCost({ model: "nanobana_2", aspect_ratio: "1:1" });
    assert.equal(imgCost, 8);

    const vidCost = VideoGenerateNode.estimateCost({ model: "ltx_2_3_fast", duration: 8 });
    assert.equal(vidCost, 16);

    const llmCost = LlmNode.estimateCost({ model: "gemini-3.1-flash-lite", prompt: "hello" });
    assert.equal(llmCost, 1);

    assert.throws(
      () => ImageGenerateNode.estimateCost({ model: "non-existent-model-xyz" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
    assert.throws(
      () => VideoGenerateNode.estimateCost({ model: "non-existent-video-xyz" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
  });

  it("base.save_media and custom.save_character_sheet persist terminal outputs cleanly", async () => {
    const dbRecords = new Map([["media-out-1", { id: "media-out-1", status: "processing", url: null }]]);
    const realShapeRepo = {
      updateFields: async (id, fields) => {
        const existing = dbRecords.get(id) || { id };
        const updated = { ...existing, ...fields };
        dbRecords.set(id, updated);
        return updated;
      },
    };

    const saved = await SaveMediaNode.execute(
      {
        media_id: "media-out-1",
        asset_url: "https://cdn.example.com/final.png",
        final_prompt: "final prompt",
        metadata: { width: 1024, height: 1024 },
      },
      {
        mediaRepository: realShapeRepo,
      }
    );
    assert.equal(saved.saved_media.id, "media-out-1");
    assert.equal(saved.saved_media.status, "completed");
    assert.equal(dbRecords.get("media-out-1").url, "https://cdn.example.com/final.png");

    const savedSheet = await SaveCharacterSheetNode.execute(
      {
        character_id: "char-77",
        media_id: "media-77",
        sheet_url: "https://cdn.example.com/sheet.png",
        description: "3-view turnaround sheet",
      },
      {
        mediaRepository: realShapeRepo,
        attachCharacterSheetResult: async ({ characterId, mediaId, sheetUrl }) => ({
          id: characterId,
          primary_media_id: mediaId,
          sheet_url: sheetUrl,
        }),
      }
    );
    assert.equal(savedSheet.saved_character_sheet.characterId, "char-77");
    assert.equal(savedSheet.saved_character_sheet.sheetUrl, "https://cdn.example.com/sheet.png");
    assert.equal(dbRecords.get("media-77").status, "completed");
  });
});
