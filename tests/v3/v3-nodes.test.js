import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  createDefaultV3NodeRegistry,
  LoadMediaNode,
  ResolveRefsNode,
  SafetyCheckNode,
  LlmTextNode,
  LlmVisionNode,
  PromptAssembleNode,
  ImageGenerateNode,
  ImageUpscaleNode,
  ImageRemoveBgNode,
  VideoGenerateNode,
  VideoUpscaleNode,
  SaveMediaNode,
  CropCharacterGridNode,
  ExtractVideoFrameNode,
  SaveCharacterSheetNode,
} from "../../src/systems/generation/internal/v3/nodes/index.js";

describe("V3 Base & Custom Nodes Suite", () => {
  it("registers all 15 standard base.* and custom.* nodes into a frozen registry", () => {
    const reg = createDefaultV3NodeRegistry();
    assert.equal(reg.isFrozen(), true);
    assert.equal(reg.list().length, 15);
    assert.equal(reg.get("base.save_media").OUTPUT_NODE, true);
    assert.equal(reg.get("custom.save_character_sheet").OUTPUT_NODE, true);
  });

  it("base.load_media resolves media IDs and checks ownership", async () => {
    let checkedResource = null;
    const out = await LoadMediaNode.execute(
      { media_id: "media-123", verify_ownership: true },
      {
        userId: "user-1",
        assertOwnsAny: async (types, id, uid) => {
          checkedResource = { types, id, uid };
        },
        getMediaById: async (id) => ({
          id,
          url: "https://cdn.example.com/media-123.png",
          width: 1024,
          height: 1024,
          status: "completed",
        }),
      }
    );

    assert.equal(out.media_url, "https://cdn.example.com/media-123.png");
    assert.deepEqual(checkedResource, {
      types: ["media", "workflow"],
      id: "media-123",
      uid: "user-1",
    });
  });

  it("base.resolve_references resolves characters, elements, and media URLs", async () => {
    const out = await ResolveRefsNode.execute(
      {
        characters: ["char-1"],
        elements: ["elem-1"],
        references: ["https://cdn.example.com/ref-direct.png", "media-99"],
      },
      {
        userId: "user-1",
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

    assert.equal(out.entities.length, 4);
    assert.equal(out.reference_urls.length, 4);
    assert.equal(out.entities[0].name, "Aria");
    assert.equal(out.entities[1].name, "Neon Jacket");
  });

  it("base.safety_check passes safe prompts and fails closed on policy violations or malformed output", async () => {
    const ok = await SafetyCheckNode.execute(
      { prompt: "A serene mountain landscape" },
      {
        executeLLM: async () => ({
          json: {
            is_safe: true,
            safety_reason: null,
            sanitized_prompt: "A serene mountain landscape at sunrise",
          },
        }),
      }
    );
    assert.equal(ok.is_safe, true);
    assert.equal(ok.safe_prompt, "A serene mountain landscape at sunrise");

    await assert.rejects(
      () =>
        SafetyCheckNode.execute(
          { prompt: "prohibited nsfw prompt" },
          {
            executeLLM: async () => ({
              json: {
                is_safe: false,
                safety_reason: "NSFW content detected",
              },
            }),
          }
        ),
      /NSFW content detected/
    );

    await assert.rejects(
      () =>
        SafetyCheckNode.execute(
          { prompt: "test fail closed" },
          {
            executeLLM: async () => ({ json: null }),
          }
        ),
      /fail-closed/
    );
  });

  it("base.llm_text and base.llm_vision execute via #models/tools contract", async () => {
    const textOut = await LlmTextNode.execute(
      { prompt: "Translate to English: Bonjour", json_mode: true },
      {
        executeLLM: async () => ({
          content: "Hello",
          json: { description: "Hello" },
          model: "gemini-3.1-flash-lite",
        }),
      }
    );
    assert.equal(textOut.text, "Hello");

    const visionOut = await LlmVisionNode.execute(
      {
        prompt: "Describe camera motion for this product",
        image_url: "https://cdn.example.com/product.png",
      },
      {
        executeLLM: async ({ images }) => ({
          content: `Slow orbital pan around ${images.length} image(s)`,
          model: "gemini-3.1-flash-lite",
        }),
      }
    );
    assert.equal(visionOut.text, "Slow orbital pan around 1 image(s)");
  });

  it("base.prompt_assemble builds 0-LLM Reference Guide and @imageN tags", async () => {
    const out = await PromptAssembleNode.execute({
      prompt: "standing in the rain",
      style: "cinematic noir",
      entities: [
        {
          entityType: "character",
          name: "Kai",
          description: "Tall detective",
          visualTraits: ["trenchcoat", "cybernetic eye"],
          imageUrls: ["https://cdn.example.com/kai-sheet.png"],
        },
      ],
    });

    assert.match(out.final_prompt, /@Kai/);
    assert.match(out.final_prompt, /\[Reference Guide\]/);
    assert.match(out.final_prompt, /@image1/);
    assert.deepEqual(out.reference_urls, ["https://cdn.example.com/kai-sheet.png"]);
  });

  it("base.image_generate, base.image_upscale, base.image_remove_bg, base.video_generate, and base.video_upscale execute cleanly", async () => {
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

    const imgUp = await ImageUpscaleNode.execute(
      { image_url: imgGen.image_url, scale_factor: 4 },
      {
        executeProvider: async () => ({
          assets: [{ url: "https://cdn.example.com/upscaled-4x.png" }],
        }),
      }
    );
    assert.equal(imgUp.image_url, "https://cdn.example.com/upscaled-4x.png");

    const rmBg = await ImageRemoveBgNode.execute(
      { image_url: imgGen.image_url },
      {
        executeProvider: async () => ({
          assets: [{ url: "https://cdn.example.com/isolated.png" }],
        }),
      }
    );
    assert.equal(rmBg.image_url, "https://cdn.example.com/isolated.png");

    const vidGen = await VideoGenerateNode.execute(
      {
        model: "kling-v1.6",
        prompt: "camera pans left",
        start_image_url: rmBg.image_url,
        duration: 5,
      },
      {
        executeProvider: async () => ({
          assets: [{ url: "https://cdn.example.com/video.mp4" }],
        }),
      }
    );
    assert.equal(vidGen.video_url, "https://cdn.example.com/video.mp4");

    const vidUp = await VideoUpscaleNode.execute(
      { video_url: vidGen.video_url, target_resolution: "4k" },
      {
        executeProvider: async () => ({
          assets: [{ url: "https://cdn.example.com/video-4k.mp4" }],
        }),
      }
    );
    assert.equal(vidUp.video_url, "https://cdn.example.com/video-4k.mp4");
  });

  it("enforces fail-closed pricing via real #models/tools calculateCost and throws on unknown models", () => {
    // Real models in #models/tools return exact catalog credits
    const imgCost = ImageGenerateNode.estimateCost({ model: "nanobana_2", aspect_ratio: "1:1" });
    assert.equal(imgCost, 8);

    const vidCost = VideoGenerateNode.estimateCost({ model: "ltx_2_3_fast", duration: 8 });
    assert.equal(vidCost, 16);

    const upscaleCost = ImageUpscaleNode.estimateCost({ model: "wavespeed_upscale", scale_factor: 4 });
    assert.equal(upscaleCost, 4);

    const vidUpscaleCost = VideoUpscaleNode.estimateCost({ model: "wavespeed_upscale", target_resolution: "4k" });
    assert.equal(vidUpscaleCost, 2);

    const rmBgCost = ImageRemoveBgNode.estimateCost({ model: "nanobana_2" });
    assert.equal(rmBgCost, 12);

    // Unknown models must fail closed instead of returning fallback 1 or 5
    assert.throws(
      () => ImageGenerateNode.estimateCost({ model: "non-existent-model-xyz" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
    assert.throws(
      () => VideoGenerateNode.estimateCost({ model: "non-existent-video-xyz" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
    assert.throws(
      () => ImageUpscaleNode.estimateCost({ model: "non-existent-upscaler" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
  });

  it("base.save_media, custom.crop_character_grid, custom.extract_video_frame, and custom.save_character_sheet work without stubs", async () => {
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

    // Test sharp 3-panel split in CropCharacterGridNode when fetched from URL (no ctx.sheetBuffer)
    const syntheticSheetBuffer = await sharp({
      create: {
        width: 300,
        height: 100,
        channels: 3,
        background: { r: 120, g: 140, b: 200 },
      },
    })
      .png()
      .toBuffer();

    const cropped = await CropCharacterGridNode.execute(
      {
        sheet_url: "https://cdn.example.com/sheet.png",
        panels: 3,
        width: 300,
        height: 100,
      },
      {
        readSourceBuffer: async () => syntheticSheetBuffer,
        mediaUploadService: {
          upload: async ({ files }) =>
            files.map((buf, idx) => {
              assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
              return { url: `https://cdn.example.com/panel-${idx + 1}.png` };
            }),
        },
      }
    );
    assert.deepEqual(cropped.panel_urls, [
      "https://cdn.example.com/panel-1.png",
      "https://cdn.example.com/panel-2.png",
      "https://cdn.example.com/panel-3.png",
    ]);

    // ExtractVideoFrameNode fails closed when no frame extraction provider is available
    await assert.rejects(
      () =>
        ExtractVideoFrameNode.execute({
          video_url: "https://cdn.example.com/clip.mp4",
          position: "first",
        }),
      /unavailable or failed/i
    );

    const extracted = await ExtractVideoFrameNode.execute(
      {
        video_url: "https://cdn.example.com/clip.mp4",
        position: "first",
      },
      {
        extractVideoFrame: async (url, pos) => `https://cdn.example.com/extracted-${pos}.png`,
      }
    );
    assert.equal(extracted.frame_url, "https://cdn.example.com/extracted-first.png");

    const savedSheet = await SaveCharacterSheetNode.execute(
      {
        character_id: "char-77",
        media_id: "media-77",
        sheet_url: "https://cdn.example.com/sheet.png",
        panel_urls: cropped.panel_urls,
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
    assert.equal(savedSheet.saved_character_sheet.panelUrls.length, 3);
    assert.equal(dbRecords.get("media-77").status, "completed");
  });
});

