import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultV3NodeRegistry,
  V3_BASE_NODES,
  V3_CUSTOM_NODES,
  ResolveRefsNode,
  LlmNode,
  ExtractNode,
  LLM_SKILLS_REGISTRY,
  buildUnifiedLlmInstruction,
  ImageGenerateNode,
  VideoGenerateNode,
  SaveMediaNode,
} from "../../src/systems/generation/internal/v3/nodes/index.js";
import {
  LLM_SKILLS_REGISTRY as SKILLS_REGISTRY_CANONICAL,
  buildUnifiedLlmInstruction as buildUnifiedLlmInstructionCanonical,
  normalizeSkillName,
  getSkill,
  listSkills,
} from "../../src/systems/generation/internal/v3/skills/index.js";
import {
  ExtractNode as ExtractNodeV3Index,
  LLM_SKILLS_REGISTRY as SKILLS_REGISTRY_V3_INDEX,
  buildUnifiedLlmInstruction as buildUnifiedLlmInstructionV3Index,
} from "../../src/systems/generation/internal/v3/index.js";
import {
  GenerationError,
  GenerationValidationError,
  GenerationCompilationError,
  GenerationUpstreamError,
} from "../../src/systems/generation/internal/errors.js";
import {
  registerProviderRunner,
  unregisterProviderRunner,
} from "../../src/systems/models/internal/runtime/providerRuntimeRegistry.js";
import { WorkflowMediaRepository, getWorkflowPrimaryMedia, persistExternalMedia, GENERATED_OUTPUT_UPLOAD_POLICY, MediaUploadService } from "#media/tools";

describe("V3 Base Nodes Suite", () => {
  it("registers the 7 pure base.* nodes and 0 custom.* nodes into a frozen registry", () => {
    const reg = createDefaultV3NodeRegistry();
    assert.equal(reg.isFrozen(), true);
    assert.equal(V3_BASE_NODES.length, 7);
    assert.equal(V3_CUSTOM_NODES.length, 0);
    assert.equal(reg.list().length, 7);
    assert.equal(reg.has("base.resolve_references"), true);
    assert.equal(reg.has("base.llm"), true);
    assert.equal(reg.has("base.extract"), true);
    assert.equal(reg.has("base.text_template"), true);
    assert.equal(reg.has("base.image_generate"), true);
    assert.equal(reg.has("base.video_generate"), true);
    assert.equal(reg.has("base.save_media"), true);
    assert.equal(reg.has("custom.save_character_sheet"), false);
    assert.equal(reg.get("base.save_media").OUTPUT_NODE, true);
    assert.equal(reg.get("base.extract").OUTPUT_NODE, false);
    assert.equal(reg.get("base.text_template").OUTPUT_NODE, false);
    assert.strictEqual(ExtractNodeV3Index, ExtractNode);
  });

  it("base.text_template interpolates variables, omits entire conditional sentences when absent, preserves 0 and @image1, and costs 0 credits", async () => {
    const reg = createDefaultV3NodeRegistry();
    const textNode = reg.get("base.text_template");
    assert.equal(textNode.estimateCost(), 0);

    const template =
      "Relight @image1 with {{light.type}} light at {{rotation}}°.{{#distance}} Distance falloff: {{distance}}/100.{{/distance}}{{#note}} Note: {{note}}.{{/note}}{{^note}} Auto style.{{/note}}";

    // Optional `distance` and `note` omitted -> their entire sentences disappear cleanly; `rotation: 0` stays!
    const withoutOptionals = await textNode.execute({
      template,
      variables: { light: { type: "soft" }, rotation: 0 },
    });
    assert.equal(
      withoutOptionals.text,
      "Relight @image1 with soft light at 0°. Auto style."
    );
    assert.deepEqual(withoutOptionals.missing_variables, []);

    // Optional `distance` and `note` provided -> both sentences included, inverted {{^note}} dropped!
    const withOptionals = await textNode.execute({
      template,
      variables: { light: { type: "hard" }, rotation: -45, distance: 30, note: "rim glow" },
    });
    assert.equal(
      withOptionals.text,
      "Relight @image1 with hard light at -45°. Distance falloff: 30/100. Note: rim glow."
    );

    // strict: true rejects missing required placeholders
    await assert.rejects(
      () => textNode.execute({ template: "Angle {{rotation}}", variables: {}, strict: true }),
      (err) => err.name === "GenerationValidationError" && /rotation/.test(err.message)
    );
  });

  it("base.resolve_references verifies ownership, resolves media/characters/elements, replaces inline tags, and embeds [Reference Guide]", async () => {
    const ownershipChecks = [];
    const out = await ResolveRefsNode.execute(
      {
        prompt: "A scene with <character:char-1> wearing <element:elem-1> at night",
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
    assert.equal(out.status, "success");
    assert.equal(out.media_url, "https://cdn.example.com/media-123.png");
    assert.equal(out.reference_urls.length, 5);
    assert.equal(out.entities.length, 5);
    assert.match(out.prepared_prompt, /@Aria/);
    assert.match(out.prepared_prompt, /@Neon Jacket/);
    assert.ok(!out.prepared_prompt.includes("<character:char-1>"));
    assert.ok(!out.prepared_prompt.includes("<element:elem-1>"));
    assert.match(out.prepared_prompt, /\[Reference Guide\]/);
    assert.match(out.prepared_prompt, /@image1/);
    assert.deepEqual(Object.keys(out).sort(), [
      "entities",
      "media_url",
      "prepared_prompt",
      "reference_urls",
      "status",
    ]);
  });

  it("base.resolve_references exposes the 8-input / 5-output contract (including allowedMediaTypes and maxReferences) and enforces strict ownership when enabled", async () => {
    assert.deepEqual(ResolveRefsNode.INPUT_TYPES.required, {});
    assert.deepEqual(Object.keys(ResolveRefsNode.INPUT_TYPES.optional).sort(), [
      "allowedMediaTypes",
      "characters",
      "elements",
      "maxReferences",
      "media_id",
      "prompt",
      "references",
      "verify_ownership",
    ]);
    assert.deepEqual(ResolveRefsNode.INPUT_TYPES.optional, {
      prompt: { type: "STRING", default: "" },
      references: { type: "ARRAY", default: [] },
      characters: { type: "ARRAY", default: [] },
      elements: { type: "ARRAY", default: [] },
      media_id: { type: "STRING" },
      verify_ownership: { type: "BOOLEAN", default: true },
      allowedMediaTypes: { type: "ARRAY" },
      maxReferences: { type: "INT" },
    });
    for (const removedInput of ["style", "template_suffix"]) {
      assert.equal(ResolveRefsNode.INPUT_TYPES.required[removedInput], undefined);
      assert.equal(ResolveRefsNode.INPUT_TYPES.optional[removedInput], undefined);
    }

    assert.deepEqual(ResolveRefsNode.RETURN_TYPES, {
      status: "STRING",
      prepared_prompt: "STRING",
      reference_urls: "ARRAY",
      entities: "ARRAY",
      media_url: "IMAGE_URL",
    });
    for (const removedOutput of ["context", "entities_context", "reference_guide", "video_url"]) {
      assert.equal(ResolveRefsNode.RETURN_TYPES[removedOutput], undefined);
    }

    const denyAll = async () => {
      throw new Error("Resource not owned");
    };

    // Default behavior discards unowned resources cleanly
    const relaxed = await ResolveRefsNode.execute(
      { prompt: "Portrait", characters: ["char-unowned"], elements: ["elem-unowned"], references: ["media-unowned"] },
      { userId: "user-2", assertOwnsAny: denyAll }
    );
    assert.equal(relaxed.status, "success");
    assert.deepEqual(relaxed.entities, []);
    assert.deepEqual(relaxed.reference_urls, []);
    assert.equal(relaxed.prepared_prompt, "Portrait");

    // strictOwnership throws GenerationError (403, OWNERSHIP_VERIFICATION_FAILED)
    await assert.rejects(
      () =>
        ResolveRefsNode.execute(
          { prompt: "Portrait", characters: ["char-unowned"] },
          { userId: "user-2", strictOwnership: true, assertOwnsAny: denyAll }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.code, "OWNERSHIP_VERIFICATION_FAILED");
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // strictMediaLoad throws GenerationError (403, OWNERSHIP_VERIFICATION_FAILED) on media_id
    await assert.rejects(
      () =>
        ResolveRefsNode.execute(
          { prompt: "Edit", media_id: "media-unowned" },
          { userId: "user-2", strictMediaLoad: true, assertOwnsAny: denyAll }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.code, "OWNERSHIP_VERIFICATION_FAILED");
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  it("base.resolve_references resolves direct HTTPS source_image_url via media_id to @image1 and Source Image guide entry (H6)", async () => {
    const sourceUrl = "https://cdn.example.com/workflows/wf-1/primary.png";
    let ownershipChecked = false;
    const res = await ResolveRefsNode.execute(
      {
        prompt: "Relight the existing image with warm golden hour light.",
        media_id: sourceUrl,
        references: ["https://cdn.example.com/workflows/wf-1/extra-ref.png"],
      },
      {
        userId: "user-edit",
        assertOwnsAny: async () => {
          ownershipChecked = true;
          return true;
        },
      }
    );

    assert.equal(res.status, "success");
    assert.equal(ownershipChecked, false, "direct HTTPS source URL passed from server must not require DB ownership lookup");
    assert.equal(res.media_url, sourceUrl);
    assert.equal(res.reference_urls[0], sourceUrl, "source_image_url must occupy @image1 (reference_urls[0])");
    assert.equal(res.reference_urls[1], "https://cdn.example.com/workflows/wf-1/extra-ref.png");
    assert.match(res.prepared_prompt, /\[Reference Guide\]/);
    assert.match(res.prepared_prompt, /Source Image \(image reference\) — @image1/);
  });

  it("base.resolve_references resolves mixed references (media_id + workflow_id + character_id + element_id) and deduplicates URLs against source_image_url", async () => {
    const sourceUrl = "https://cdn.example.com/workflows/wf-target/primary.png";
    const res = await ResolveRefsNode.execute(
      {
        prompt: "Place @Lyra holding @Runeblade on the rooftop",
        media_id: sourceUrl,
        references: [
          "media-direct-1",
          "wf-ref-2",
          "char-ref-3",
          "elem-ref-4",
          // Duplicate URL matching source_image_url and duplicate workflow returning sourceUrl
          sourceUrl,
          { type: "workflow", id: "wf-dup-source" },
          // Typed character & duplicate media ID
          { type: "media", id: "media-direct-1" },
        ],
        verify_ownership: true,
      },
      {
        userId: "user-multi",
        assertOwnsAny: async () => true,
        getMediaUrls: async (ids) => {
          if (ids.includes("media-direct-1")) {
            return [{ mediaId: "media-direct-1", url: "https://cdn.example.com/media-direct-1.png", status: "success" }];
          }
          return [];
        },
        getCharacterPromptContext: async ({ characterId }) => {
          if (characterId === "char-ref-3") {
            return {
              id: "char-ref-3",
              workflowId: "wf-char-ref-3",
              name: "Lyra",
              description: "Silver-armored pilot",
              traits: { hair: "indigo" },
              referenceMediaUrls: [
                "https://cdn.example.com/lyra-sheet.png",
                sourceUrl, // Duplicate of source_image_url must NOT create a duplicate slot
                "https://cdn.example.com/lyra-detail.png",
              ],
            };
          }
          throw new Error("Character not found");
        },
        getElementPromptContext: async ({ elementIds }) => {
          if (elementIds.includes("elem-ref-4")) {
            return {
              elements: [
                {
                  id: "elem-ref-4",
                  workflowId: "wf-elem-ref-4",
                  name: "Runeblade",
                  description: "Glowing cyan sword",
                  guidelines: "Keep glowing runes",
                  referenceMediaUrls: [
                    "https://cdn.example.com/runeblade-cover.png",
                    "https://cdn.example.com/lyra-detail.png", // Cross-entity duplicate URL
                  ],
                },
              ],
            };
          }
          throw new Error("Element not found");
        },
        getWorkflowPrimaryMedia: async (wfId) => {
          if (wfId === "wf-ref-2") {
            return {
              mediaId: "m-wf-2-primary",
              url: "https://cdn.example.com/wf-ref-2-primary.png",
              role: "output",
              status: "success",
            };
          }
          if (wfId === "wf-dup-source") {
            return {
              mediaId: "m-dup-src",
              url: sourceUrl,
              role: "output",
              status: "success",
            };
          }
          return null;
        },
      }
    );

    assert.equal(res.status, "success");
    assert.deepEqual(res.reference_urls, [
      sourceUrl,
      "https://cdn.example.com/media-direct-1.png",
      "https://cdn.example.com/wf-ref-2-primary.png",
      "https://cdn.example.com/lyra-sheet.png",
      "https://cdn.example.com/lyra-detail.png",
      "https://cdn.example.com/runeblade-cover.png",
    ]);
    // Verify no duplicate Source Image / generic media entity was added for sourceUrl
    const mediaGuideMentions = res.entities.filter((e) => e.entityType === "media");
    assert.equal(mediaGuideMentions.length, 3);
    assert.equal(res.entities.some((e) => e.entityType === "character" && e.name === "Lyra"), true);
    assert.equal(res.entities.some((e) => e.entityType === "element" && e.name === "Runeblade"), true);
    assert.match(res.prepared_prompt, /@Lyra \(character\)/);
    assert.match(res.prepared_prompt, /@Runeblade \(element\)/);
    assert.match(res.prepared_prompt, /Source Image \(image reference\) — @image1/);
  });

  it("getWorkflowPrimaryMedia resolves fallback completed non-reference media when primary is failed", async () => {
    const mockWfRepo = {
      findByWorkflow: async () => [
        { id: "m-1", url: "https://cdn.example.com/v1.png", status: "success", role: "output", is_primary: false },
        { id: "m-ref", url: "https://cdn.example.com/ref.png", status: "success", role: "reference", is_primary: false },
        { id: "m-2", url: "https://cdn.example.com/v2.png", status: "success", role: "output", is_primary: false },
        { id: "m-fail", url: null, status: "failed", role: "output", is_primary: true, generation_config: {} },
      ],
    };

    const resolved = await getWorkflowPrimaryMedia("wf-failed-primary", {
      workflowMediaRepository: mockWfRepo,
    });
    assert.ok(resolved);
    assert.equal(resolved.mediaId, "m-2");
    assert.equal(resolved.url, "https://cdn.example.com/v2.png");
  });

  it("base.image_generate deduplicates and caps expanded images to model.parameters.images.max preserving source_image_url", async () => {
    let capturedInput = null;
    const expandedUrls = Array.from({ length: 18 }, (_, i) => `https://cdn.example.com/ref-${i + 1}.png`);
    // Include duplicates too
    const withDups = [expandedUrls[0], expandedUrls[0], ...expandedUrls.slice(1), expandedUrls[2]];

    const res = await ImageGenerateNode.execute(
      {
        model: "nanobana_2", // images.max === 14
        operation: "edit",
        prompt: "Composite character and elements into scene",
        images: withDups,
      },
      {
        executeProvider: async (model, params) => {
          capturedInput = { model, params };
          return {
            assets: [{ url: "https://cdn.example.com/final-capped.png" }],
            metadata: { model: "nanobana_2", provider: "wavespeed" },
          };
        },
      }
    );

    assert.equal(res.status, "success");
    assert.equal(capturedInput.params.images.length, 14, "nanobana_2 must cap images at 14");
    assert.equal(capturedInput.params.images[0], "https://cdn.example.com/ref-1.png", "@image1 source preserved");
    assert.equal(new Set(capturedInput.params.images).size, 14, "all capped URLs must be unique");
  });

  it("base.resolve_references with allowedMediaTypes: ['image'] rejects video URLs/media with non-retryable UNSUPPORTED_MEDIA_TYPE while accepting images", async () => {
    // 1. Accepts images cleanly
    const okRes = await ResolveRefsNode.execute(
      {
        prompt: "Relight portrait",
        media_id: "https://cdn.example.com/photo.png",
        references: ["https://cdn.example.com/style-ref.webp"],
        allowedMediaTypes: ["image"],
      },
      { userId: "u-img-1", assertOwnsAny: async () => true }
    );
    assert.equal(okRes.status, "success");
    assert.equal(okRes.reference_urls.length, 2);

    // 2. Rejects video URL extension (.mp4, .webm, .mov, .m4v) on source_image_url / references
    for (const badUrl of [
      "https://cdn.example.com/clip.mp4?token=abc",
      "https://cdn.example.com/clip.webm",
      "https://cdn.example.com/clip.mov",
      "https://cdn.example.com/clip.m4v",
    ]) {
      await assert.rejects(
        () =>
          ResolveRefsNode.execute(
            { prompt: "Edit", media_id: badUrl, allowedMediaTypes: ["image"] },
            { userId: "u-img-1" }
          ),
        (err) => {
          assert.ok(err instanceof GenerationError);
          assert.equal(err.code, "UNSUPPORTED_MEDIA_TYPE");
          assert.equal(err.statusCode, 400);
          assert.equal(err.retryable, false);
          assert.equal(err.billingAction, "REFUND_HOLD");
          return true;
        }
      );
    }

    // 3. Rejects extensionless video media detected by mime_type: "video/mp4"
    await assert.rejects(
      () =>
        ResolveRefsNode.execute(
          { prompt: "Edit", references: ["media-vid-mime"], allowedMediaTypes: ["image"] },
          {
            userId: "u-img-1",
            assertOwnsAny: async () => true,
            getMediaUrls: async () => [
              {
                mediaId: "media-vid-mime",
                url: "https://cdn.example.com/signed/asset-1",
                status: "success",
                mime_type: "video/mp4",
              },
            ],
          }
        ),
      (err) => err instanceof GenerationError && err.code === "UNSUPPORTED_MEDIA_TYPE" && err.retryable === false
    );

    // 4. Rejects extensionless video workflow detected by step_id: "video_generation"
    await assert.rejects(
      () =>
        ResolveRefsNode.execute(
          { prompt: "Edit", references: ["wf-video-1"], allowedMediaTypes: ["image"] },
          {
            userId: "u-img-1",
            assertOwnsAny: async () => true,
            getMediaUrls: async () => [],
            getCharacterPromptContext: async () => {
              throw new Error("Character not found");
            },
            getElementPromptContext: async () => {
              throw new Error("Element not found");
            },
            getWorkflowPrimaryMedia: async () => ({
              mediaId: "m-vid-1",
              url: "https://cdn.example.com/signed/asset-2",
              status: "success",
              step_id: "video_generation",
            }),
          }
        ),
      (err) => err instanceof GenerationError && err.code === "UNSUPPORTED_MEDIA_TYPE" && err.retryable === false
    );
  });

  it("base.resolve_references with allowedMediaTypes: ['video'] accepts video and rejects images", async () => {
    const okVideo = await ResolveRefsNode.execute(
      {
        prompt: "Extend this shot by 5 seconds",
        media_id: "https://cdn.example.com/clips/scene-1.mp4",
        references: ["wf-video-ref"],
        allowedMediaTypes: ["video"],
      },
      {
        userId: "u-vid-1",
        assertOwnsAny: async () => true,
        getMediaUrls: async () => [],
        getCharacterPromptContext: async () => {
          throw new Error("Character not found");
        },
        getElementPromptContext: async () => {
          throw new Error("Element not found");
        },
        getWorkflowPrimaryMedia: async () => ({
          mediaId: "m-vid-ref",
          url: "https://cdn.example.com/signed/video-asset",
          status: "success",
          media_type: "video",
        }),
      }
    );
    assert.equal(okVideo.status, "success");
    assert.deepEqual(okVideo.reference_urls, [
      "https://cdn.example.com/clips/scene-1.mp4",
      "https://cdn.example.com/signed/video-asset",
    ]);

    await assert.rejects(
      () =>
        ResolveRefsNode.execute(
          {
            prompt: "Extend video",
            media_id: "https://cdn.example.com/photos/still.png",
            allowedMediaTypes: ["video"],
          },
          { userId: "u-vid-1" }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.equal(err.code, "UNSUPPORTED_MEDIA_TYPE");
        assert.equal(err.statusCode, 400);
        assert.equal(err.retryable, false);
        return true;
      }
    );
  });

  it("base.resolve_references batches media lookups, propagates 5xx DB errors, caps maxReferences before [Reference Guide], and respects verify_ownership: false", async () => {
    // 1. Batches media lookups into 1 getMediaUrls call and caps maxReferences before building [Reference Guide]
    let mediaUrlBatchCalls = 0;
    const capped = await ResolveRefsNode.execute(
      {
        prompt: "Combine references",
        media_id: "https://cdn.example.com/src.png",
        references: ["m-1", "m-2", "m-3", "m-4"],
        maxReferences: 3,
        verify_ownership: false,
      },
      {
        userId: "user-cap",
        getMediaUrls: async (ids) => {
          mediaUrlBatchCalls++;
          assert.deepEqual(ids, ["m-1", "m-2", "m-3", "m-4"], "must batch all media/auto IDs into a single getMediaUrls call");
          return ids.map((id) => ({ mediaId: id, url: `https://cdn.example.com/${id}.png`, status: "success" }));
        },
      }
    );
    assert.equal(mediaUrlBatchCalls, 1);
    assert.deepEqual(capped.reference_urls, [
      "https://cdn.example.com/src.png",
      "https://cdn.example.com/m-1.png",
      "https://cdn.example.com/m-2.png",
    ]);
    assert.ok(!capped.prepared_prompt.includes("@image4"), "[Reference Guide] must not reference truncated @image4+");

    // 2. Respects verify_ownership: false in Steps 1 and 2 (passes userId: null to character/element tools)
    const capturedUserIds = [];
    const noOwnerRes = await ResolveRefsNode.execute(
      { prompt: "Scene", characters: ["c-1"], elements: ["e-1"], verify_ownership: false },
      {
        userId: "user-admin",
        getCharacterPromptContext: async ({ userId }) => {
          capturedUserIds.push({ kind: "character", userId });
          return { name: "Hero", referenceMediaUrls: ["https://cdn.example.com/hero.png"] };
        },
        getElementPromptContext: async ({ userId }) => {
          capturedUserIds.push({ kind: "element", userId });
          return { elements: [{ id: "e-1", name: "Shield", referenceMediaUrls: ["https://cdn.example.com/shield.png"] }] };
        },
      }
    );
    assert.equal(noOwnerRes.status, "success");
    assert.deepEqual(capturedUserIds, [
      { kind: "character", userId: null },
      { kind: "element", userId: null },
    ]);

    // 3. Propagates transient 5xx DB errors instead of silently dropping references
    await assert.rejects(
      () =>
        ResolveRefsNode.execute(
          { prompt: "Scene", references: ["m-db-err"], verify_ownership: false },
          {
            getMediaUrls: async () => {
              const err = new Error("Supabase connection timeout");
              err.statusCode = 503;
              throw err;
            },
          }
        ),
      /Supabase connection timeout/
    );
  });

  it("persistExternalMedia uses GENERATED_OUTPUT_UPLOAD_POLICY so 4K/8K PNG outputs are not downscaled to 2048px WebP", async () => {
    let capturedPolicy = null;
    const saved = await persistExternalMedia({
      mediaId: "m-4k-1",
      source: "https://wavespeed.example.com/render-8k.png",
      userId: "u-4k-1",
      mediaRepository: {
        findById: async () => ({ id: "m-4k-1", status: "processing", generation_config: {} }),
        updateMedia: async (id, patch) => ({ id, ...patch }),
      },
      workflowMediaRepository: {
        isMediaLinkedToWorkflow: async () => true,
        linkMedia: async (l) => l,
      },
      uploadService: {
        upload: async ({ policy }) => {
          capturedPolicy = policy;
          return {
            uploaded: [
              {
                url: "https://supabase.example.com/storage/v1/object/public/generated_images/u-4k-1/uploads/render-8k.png",
                storageKey: "u-4k-1/uploads/render-8k.png",
                width: 7680,
                height: 4320,
              },
            ],
          };
        },
      },
    });
    assert.equal(capturedPolicy, GENERATED_OUTPUT_UPLOAD_POLICY);
    assert.equal(capturedPolicy.preserveOriginal, true);
    assert.equal(saved.width, 7680);
    assert.equal(saved.height, 4320);

    // Verify MediaUploadService._prepareUploadPayload skips resize when preserveOriginal === true
    const dummyStorage = {
      upload: async () => "https://cdn.example.com/out.png",
      deleteFiles: async () => ({ failures: [] }),
      buildKey: () => "k",
      validateFolder: () => "uploads",
    };
    const uploadSvc = new MediaUploadService({ storageService: dummyStorage });
    const rawBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const prepared = await uploadSvc._prepareUploadPayload(
      {
        buffer: rawBuf,
        originalName: "render-4k.png",
        inspection: {
          type: "image",
          width: 4096,
          height: 4096,
          sizeBytes: 4,
          detectedMime: "image/png",
          ratio: "1:1",
          format: "PNG",
        },
      },
      GENERATED_OUTPUT_UPLOAD_POLICY
    );
    assert.equal(prepared.width, 4096, "4K PNG must NOT be resized to 2048px");
    assert.equal(prepared.height, 4096);
    assert.equal(prepared.mimeType, "image/png", "PNG must NOT be converted to lossy WebP");
    assert.equal(prepared.buffer, rawBuf);
  });

  it("base.llm exposes the minimal 4-input / 4-output contract and SKILL.md registry re-exports", () => {
    assert.deepEqual(LlmNode.INPUT_TYPES.required, {});
    assert.deepEqual(Object.keys(LlmNode.INPUT_TYPES.optional).sort(), [
      "images",
      "model",
      "prompt",
      "skills",
    ]);
    assert.deepEqual(LlmNode.INPUT_TYPES.optional, {
      model: { type: "STRING", default: "gemini-3.1-flash-lite" },
      prompt: { type: "STRING", default: "" },
      images: { type: "ARRAY", default: [] },
      skills: { type: "ARRAY", default: [] },
    });

    for (const removedInput of [
      "instruction",
      "reference_guide",
      "json_mode",
      "schema",
      "image_url",
      "custom_instruction",
      "system_instruction",
    ]) {
      assert.equal(LlmNode.INPUT_TYPES.required[removedInput], undefined);
      assert.equal(LlmNode.INPUT_TYPES.optional[removedInput], undefined);
    }

    assert.deepEqual(LlmNode.RETURN_TYPES, {
      status: "STRING",
      text: "STRING",
      json: "JSON",
      metadata: "JSON",
    });

    for (const removedOutput of [
      "final_prompt",
      "is_safe",
      "character_description",
      "character_title",
      "safe_prompt",
    ]) {
      assert.equal(LlmNode.RETURN_TYPES[removedOutput], undefined);
    }

    // SKILL.md Registry module & re-exports stay synchronized and deeply frozen
    assert.strictEqual(LLM_SKILLS_REGISTRY, SKILLS_REGISTRY_CANONICAL);
    assert.strictEqual(SKILLS_REGISTRY_V3_INDEX, SKILLS_REGISTRY_CANONICAL);
    assert.strictEqual(buildUnifiedLlmInstruction, buildUnifiedLlmInstructionCanonical);
    assert.strictEqual(buildUnifiedLlmInstructionV3Index, buildUnifiedLlmInstructionCanonical);
    assert.equal(Object.isFrozen(LLM_SKILLS_REGISTRY), true);
    assert.equal(Object.isFrozen(listSkills()), true);
    assert.deepEqual(
      [...listSkills()].sort(),
      [
        "character-description",
        "character-sheet",
        "image-edit",
        "image-generation",
        "json-output",
        "system-safety",
        "translate",
        "translation",
        "video-generation",
      ]
    );

    // Canonical metadata + alias identity checks
    const safetySkill = getSkill("llm/system-safety");
    assert.strictEqual(safetySkill, LLM_SKILLS_REGISTRY["system-safety"]);
    assert.equal(Object.isFrozen(safetySkill), true);
    assert.equal(safetySkill.id, "system-safety");
    assert.equal(safetySkill.guard, "safety");
    assert.equal(safetySkill.requiresSafetyCheck, true);
    assert.equal(safetySkill.requiresJson, true);
    assert.ok(safetySkill.description.length > 0);
    assert.ok(safetySkill.instruction.length > 0);

    assert.equal(normalizeSkillName("  LLM/Translate "), "translate");
    assert.strictEqual(getSkill("translation"), getSkill("translate"));
    assert.equal(getSkill("translation").id, "translate");
    assert.deepEqual(getSkill("translate").aliases, ["translation"]);

    assert.strictEqual(getSkill("character-description"), getSkill("character-sheet"));
    assert.equal(getSkill("character-description").id, "character-sheet");
    assert.deepEqual(getSkill("character-sheet").aliases, ["character-description"]);

    for (const canonicalId of [
      "system-safety",
      "translate",
      "image-generation",
      "image-edit",
      "video-generation",
      "character-sheet",
      "json-output",
    ]) {
      const spec = getSkill(canonicalId);
      assert.ok(spec, `Expected SKILL.md entry for "${canonicalId}"`);
      assert.equal(spec.id, canonicalId);
      assert.equal(spec.name, canonicalId);
      assert.equal(spec.requiresJson, true);
      assert.ok(spec.instruction.trim().length > 0);
      assert.equal(Object.isFrozen(spec), true);
    }

    assert.equal(getSkill("toString"), null);
    assert.equal(getSkill("__proto__"), null);
    assert.equal(getSkill("non-existent-skill"), null);
  });

  it("buildUnifiedLlmInstruction injects <skill name=\"...\"> XML blocks, deduplicates aliases, and supports empty skills", () => {
    const emptyRes = buildUnifiedLlmInstruction([]);
    assert.equal(emptyRes.systemInstruction, "");
    assert.equal(emptyRes.requiresSafety, false);
    assert.equal(emptyRes.useJsonMode, false);
    assert.deepEqual(emptyRes.activeSkills, []);

    const composed = buildUnifiedLlmInstruction([
      "system-safety",
      "translation",
      "translate",
      "character-description",
      "character-sheet",
    ]);
    assert.equal(composed.requiresSafety, true);
    assert.equal(composed.useJsonMode, true);
    assert.deepEqual(composed.activeSkills, ["system-safety", "translate", "character-sheet"]);

    assert.match(composed.systemInstruction, /<skill name="system-safety">[\s\S]*?<\/skill>/);
    assert.match(composed.systemInstruction, /<skill name="translate">[\s\S]*?<\/skill>/);
    assert.match(composed.systemInstruction, /<skill name="character-sheet">[\s\S]*?<\/skill>/);
    assert.equal(
      (composed.systemInstruction.match(/<skill name="translate">/g) || []).length,
      1,
      "Duplicate canonical skill aliases must be deduplicated"
    );
    assert.equal(
      (composed.systemInstruction.match(/<skill name="character-sheet">/g) || []).length,
      1,
      "Duplicate canonical skill aliases must be deduplicated"
    );
    assert.match(composed.systemInstruction, /valid JSON object/i);
  });

  it("base.llm executes single-call SKILL.md skills with XML injection and fails closed on safety, schema, or billing context violations", async () => {
    let capturedCall = null;
    const ok = await LlmNode.execute(
      {
        prompt: "@Aria قطوس في الفضاء\n\n[Reference Guide]\n@Aria (character)\n  visual references: @image1",
        images: ["https://cdn.example.com/char-1.png"],
        skills: ["system-safety", "translation", "character-description"],
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
    assert.equal(capturedCall.jsonMode, true);
    assert.deepEqual(capturedCall.images, ["https://cdn.example.com/char-1.png"]);
    assert.match(capturedCall.systemInstruction, /<skill name="system-safety">/);
    assert.match(capturedCall.systemInstruction, /<skill name="translate">/);
    assert.match(capturedCall.systemInstruction, /<skill name="character-sheet">/);

    assert.equal(ok.status, "success");
    assert.equal(ok.text, "@Aria cat in space with @image1");
    assert.equal(
      ok.text.includes("[Reference Guide]"),
      false,
      "base.llm must NOT perform hardcoded [Reference Guide] slicing or injection"
    );
    assert.deepEqual(ok.json, {
      is_safe: true,
      safety_reason: null,
      prompt: "@Aria cat in space with @image1",
      character_description: "Full body 3-view turnaround of @Aria",
      character_title: "Space Cat Aria",
    });
    assert.equal("title" in ok.json, false, "base.llm must NOT mutate json with hardcoded title field");
    assert.equal("final_prompt" in ok, false);
    assert.equal("is_safe" in ok, false);
    assert.equal("character_description" in ok, false);
    assert.equal("safe_prompt" in ok, false);
    assert.equal("character_title" in ok, false);
    assert.deepEqual(Object.keys(ok).sort(), ["json", "metadata", "status", "text"]);
    assert.deepEqual(ok.metadata, {
      model: "gemini-3.1-flash-lite",
      skills: ["system-safety", "translation", "character-description"],
      imagesCount: 1,
      durationMs: 0,
    });

    // Plain-text mode (default skills: []): jsonMode is false and raw content maps cleanly to text
    let plainCall = null;
    const plainRes = await LlmNode.execute(
      {
        prompt: "Write a short haiku about neon rain",
      },
      {
        userId: "user-1",
        executeLLM: async (args) => {
          plainCall = args;
          return {
            content: "Neon drops fall soft\nMirrors hum on midnight streets\nCity dreams awake",
            model: "gemini-3.1-flash-lite",
          };
        },
      }
    );
    assert.equal(plainCall.jsonMode, false);
    assert.equal(plainCall.systemInstruction, "");
    assert.equal(plainRes.status, "success");
    assert.equal(
      plainRes.text,
      "Neon drops fall soft\nMirrors hum on midnight streets\nCity dreams awake"
    );
    assert.deepEqual(plainRes.json, {});
    assert.deepEqual(plainRes.metadata.skills, []);

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
      (err) => {
        assert.equal(err.code, "SAFETY_CHECK_FAILED");
        assert.equal(err.is_safe, false);
        assert.match(err.message, /fail-closed/i);
        return true;
      }
    );

    await assert.rejects(
      () =>
        LlmNode.execute(
          {
            prompt: "missing billing context",
            skills: ["system-safety"],
          },
          {
            userId: null,
            executeLLM: async () => {
              const err = new Error("userId is required for LLM execution");
              err.code = "BILLING_CONTEXT_MISSING";
              err.statusCode = 500;
              err.category = "SERVER_FAULT";
              throw err;
            },
          }
        ),
      (err) => {
        assert.equal(err.code, "BILLING_CONTEXT_MISSING");
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });

  it("base.llm fails closed with GenerationValidationError (field: skills) on unknown or invalid skill names", async () => {
    let llmCalled = false;
    const ctx = {
      userId: "user-skills-check",
      executeLLM: async () => {
        llmCalled = true;
        return { json: { is_safe: true, prompt: "should not run" } };
      },
    };

    await assert.rejects(
      () =>
        LlmNode.execute(
          {
            prompt: "test typo skill",
            skills: ["system-safety", "imge-edit"],
          },
          ctx
        ),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "skills");
        assert.equal(err.context?.skill, "imge-edit");
        assert.match(err.message, /Unknown LLM skill/i);
        return true;
      }
    );

    for (const invalidSkills of [
      ["system-safety", ""],
      ["system-safety", "   "],
      ["system-safety", null],
      ["system-safety", 42],
      "translate",
    ]) {
      await assert.rejects(
        () =>
          LlmNode.execute(
            {
              prompt: "test invalid skills input",
              skills: invalidSkills,
            },
            ctx
          ),
        (err) => {
          assert.ok(err instanceof GenerationValidationError);
          assert.equal(err.field, "skills");
          return true;
        }
      );
    }

    assert.equal(llmCalled, false, "executeLLM must never be invoked when skill validation fails");

    assert.throws(
      () => buildUnifiedLlmInstruction(["system-safety", "imge-edit"]),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "skills");
        assert.equal(err.context?.skill, "imge-edit");
        return true;
      }
    );
  });

  it("base.llm supports prompt-only and image-only execution and rejects when both prompt and images are empty", async () => {
    const calls = [];
    const ctx = {
      userId: "user-promptless",
      executeLLM: async (args) => {
        calls.push(args);
        return {
          json: {
            is_safe: true,
            prompt: "Generated from minimal inputs",
          },
          model: "gemini-3.1-flash-lite",
        };
      },
    };

    const promptOnly = await LlmNode.execute(
      {
        prompt: "A dramatic noir product shot",
        skills: ["system-safety"],
      },
      ctx
    );
    assert.equal(promptOnly.status, "success");
    assert.equal(promptOnly.text, "Generated from minimal inputs");
    assert.equal(calls[0].prompt, "A dramatic noir product shot");
    assert.deepEqual(calls[0].images, []);

    const imageOnly = await LlmNode.execute(
      {
        images: "https://cdn.example.com/product.png",
        skills: ["system-safety"],
      },
      ctx
    );
    assert.equal(imageOnly.status, "success");
    assert.equal(imageOnly.text, "Generated from minimal inputs");
    assert.equal(imageOnly.metadata.imagesCount, 1);
    assert.ok(calls[1].prompt.trim().length > 0, "executeLLM must receive a non-empty fallback prompt");
    assert.deepEqual(calls[1].images, ["https://cdn.example.com/product.png"]);

    const callsBeforeEmpty = calls.length;
    for (const emptyInput of [
      {},
      { prompt: "   ", images: [] },
      { prompt: "", images: ["   ", null, { url: "" }] },
    ]) {
      await assert.rejects(
        () => LlmNode.execute(emptyInput, ctx),
        (err) => {
          assert.ok(err instanceof GenerationValidationError);
          assert.equal(err.field, "prompt");
          return true;
        }
      );
    }
    assert.equal(calls.length, callsBeforeEmpty, "executeLLM must not run when prompt and images are both empty");
  });

  it("base.llm normalizes images from single URL string, { url } object, or deduplicated array", async () => {
    const capturedImages = [];
    const ctx = {
      userId: "user-images-norm",
      executeLLM: async (args) => {
        capturedImages.push(args.images);
        return {
          json: { is_safe: true, prompt: "ok" },
          model: "gemini-3.1-flash-lite",
        };
      },
    };

    const singleStrRes = await LlmNode.execute(
      {
        prompt: "inspect single string",
        images: "  https://cdn.example.com/single.png  ",
        skills: ["system-safety"],
      },
      ctx
    );
    assert.equal(singleStrRes.status, "success");
    assert.equal(singleStrRes.metadata.imagesCount, 1);
    assert.deepEqual(capturedImages[0], ["https://cdn.example.com/single.png"]);

    const singleObjRes = await LlmNode.execute(
      {
        prompt: "inspect single object",
        images: { url: "  https://cdn.example.com/object.png " },
        skills: ["system-safety"],
      },
      ctx
    );
    assert.equal(singleObjRes.status, "success");
    assert.equal(singleObjRes.metadata.imagesCount, 1);
    assert.deepEqual(capturedImages[1], ["https://cdn.example.com/object.png"]);

    const dedupArrayRes = await LlmNode.execute(
      {
        prompt: "inspect mixed deduplicated array",
        images: [
          "  https://cdn.example.com/a.png  ",
          "",
          "   ",
          null,
          { url: "https://cdn.example.com/a.png" },
          { url: "  https://cdn.example.com/b.png " },
          { url: "" },
          "https://cdn.example.com/b.png",
        ],
        skills: ["system-safety"],
      },
      ctx
    );
    assert.equal(dedupArrayRes.status, "success");
    assert.equal(dedupArrayRes.metadata.imagesCount, 2);
    assert.deepEqual(capturedImages[2], [
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.png",
    ]);
  });

  it("base.extract exposes a zero-credit contract and resolves dot-paths, array indices, defaults, and serialization safely", async () => {
    assert.equal(ExtractNode.type, "base.extract");
    assert.equal(ExtractNode.category, "data");
    assert.equal(ExtractNode.OUTPUT_NODE, false);
    assert.deepEqual(ExtractNode.INPUT_TYPES, {
      required: {
        data: { type: "ANY" },
        path: { type: "STRING" },
      },
      optional: {
        default_value: { type: "ANY" },
      },
    });
    assert.deepEqual(ExtractNode.RETURN_TYPES, {
      value: "ANY",
      text: "STRING",
    });
    assert.equal(ExtractNode.estimateCost({ data: { a: 1 }, path: "a" }), 0);

    // Top-level & nested dot-paths
    const simple = await ExtractNode.execute({
      data: { character_description: "Tall silver-haired astronaut in white carbon armor" },
      path: "character_description",
    });
    assert.deepEqual(simple, {
      value: "Tall silver-haired astronaut in white carbon armor",
      text: "Tall silver-haired astronaut in white carbon armor",
    });

    const nested = await ExtractNode.execute({
      data: { meta: { camera: { lens: "35mm anamorphic" } } },
      path: "meta.camera.lens",
    });
    assert.deepEqual(nested, { value: "35mm anamorphic", text: "35mm anamorphic" });

    // Nested array index paths (dot notation, bracket notation, and top-level array)
    const storyboard = {
      shots: [
        { prompt: "Opening wide shot over neon harbor", duration: 6 },
        { prompt: "Close-up of pilot visor", tags: ["sci-fi", "macro"] },
      ],
    };
    const shot0 = await ExtractNode.execute({ data: storyboard, path: "shots.0.prompt" });
    assert.deepEqual(shot0, {
      value: "Opening wide shot over neon harbor",
      text: "Opening wide shot over neon harbor",
    });

    const shot1Tag = await ExtractNode.execute({ data: storyboard, path: "shots[1].tags.0" });
    assert.deepEqual(shot1Tag, { value: "sci-fi", text: "sci-fi" });

    const topLevelArr = await ExtractNode.execute({
      data: [{ prompt: "First scene" }, { prompt: "Second scene" }],
      path: "1.prompt",
    });
    assert.deepEqual(topLevelArr, { value: "Second scene", text: "Second scene" });

    // Non-string values serialize cleanly into text
    const objectOut = await ExtractNode.execute({ data: storyboard, path: "shots.0" });
    assert.deepEqual(objectOut.value, { prompt: "Opening wide shot over neon harbor", duration: 6 });
    assert.equal(
      objectOut.text,
      JSON.stringify({ prompt: "Opening wide shot over neon harbor", duration: 6 })
    );

    // Falsy primitives (0, false) are preserved, NOT treated as empty
    const zeroOut = await ExtractNode.execute({
      data: { count: 0, enabled: false },
      path: "count",
      default_value: 99,
    });
    assert.deepEqual(zeroOut, { value: 0, text: "0" });

    const falseOut = await ExtractNode.execute({
      data: { count: 0, enabled: false },
      path: "enabled",
      default_value: true,
    });
    assert.deepEqual(falseOut, { value: false, text: "false" });

    // Fallback default_value on missing, null, undefined, or blank string
    for (const [data, path] of [
      [{}, "character_description"],
      [{ character_description: null }, "character_description"],
      [{ character_description: "   " }, "character_description"],
      [storyboard, "shots.99.prompt"],
      [null, "anything"],
    ]) {
      const fallback = await ExtractNode.execute({
        data,
        path,
        default_value: "fallback description",
      });
      assert.deepEqual(fallback, {
        value: "fallback description",
        text: "fallback description",
      });
    }

    // Missing with no default_value -> value: undefined, text: ""
    const missingNoDefault = await ExtractNode.execute({ data: {}, path: "missing.key" });
    assert.deepEqual(missingNoDefault, { value: undefined, text: "" });

    // Prototype keys are blocked safely
    for (const dangerousPath of ["__proto__", "constructor", "shots.__proto__.polluted"]) {
      const blocked = await ExtractNode.execute({
        data: storyboard,
        path: dangerousPath,
        default_value: "safe-default",
      });
      assert.deepEqual(blocked, { value: "safe-default", text: "safe-default" });
    }

    // Missing or blank path throws GenerationValidationError (field: path)
    for (const badPath of [undefined, null, "", "   "]) {
      await assert.rejects(
        () => ExtractNode.execute({ data: { a: 1 }, path: badPath }),
        (err) => {
          assert.ok(err instanceof GenerationValidationError);
          assert.equal(err.field, "path");
          return true;
        }
      );
    }
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
    assert.equal(imgGen.status, "success");
    assert.equal(imgGen.image_url, "https://cdn.example.com/flux-schnell.png");
    assert.deepEqual(imgGen.assets, [{ url: "https://cdn.example.com/flux-schnell.png" }]);
    assert.equal(imgGen.metadata.model, "flux-schnell");

    const vidGen = await VideoGenerateNode.execute(
      {
        model: "kling-v1.6",
        prompt: "camera pans left",
        start_image_url: imgGen.image_url,
        parameters: { duration: 5 },
      },
      {
        executeProvider: async () => ({
          assets: [{ url: "https://cdn.example.com/video.mp4" }],
        }),
      }
    );
    assert.equal(vidGen.status, "success");
    assert.equal(vidGen.video_url, "https://cdn.example.com/video.mp4");
    assert.deepEqual(vidGen.assets, [{ url: "https://cdn.example.com/video.mp4" }]);
    assert.equal(vidGen.metadata.model, "kling-v1.6");
  });

  it("base.video_generate exposes the simplified INPUT_TYPES and RETURN_TYPES contract", () => {
    assert.deepEqual(Object.keys(VideoGenerateNode.INPUT_TYPES.required).sort(), ["model", "prompt"]);
    assert.deepEqual(VideoGenerateNode.INPUT_TYPES.required, {
      model: { type: "STRING" },
      prompt: { type: "STRING" },
    });

    assert.deepEqual(Object.keys(VideoGenerateNode.INPUT_TYPES.optional).sort(), [
      "end_image_url",
      "input_video_url",
      "parameters",
      "start_image_url",
    ]);
    assert.deepEqual(VideoGenerateNode.INPUT_TYPES.optional, {
      start_image_url: { type: "IMAGE_URL" },
      end_image_url: { type: "IMAGE_URL" },
      input_video_url: { type: "VIDEO_URL" },
      parameters: { type: "JSON", default: {} },
    });

    for (const removedKey of ["duration", "aspect_ratio"]) {
      assert.equal(VideoGenerateNode.INPUT_TYPES.required[removedKey], undefined);
      assert.equal(VideoGenerateNode.INPUT_TYPES.optional[removedKey], undefined);
    }

    assert.deepEqual(VideoGenerateNode.RETURN_TYPES, {
      status: "STRING",
      video_url: "VIDEO_URL",
      assets: "ARRAY",
      metadata: "JSON",
    });
  });

  it("base.video_generate executes with minimal inputs (model + prompt only) using manifest defaults and validates required fields", async () => {
    let capturedCall = null;
    const res = await VideoGenerateNode.execute(
      { model: "ltx_2_3_fast", prompt: "minimal alpine drone flight" },
      {
        userId: "user-vid-minimal",
        executeGeneration: async (call) => {
          capturedCall = call;
          return {
            assets: [{ url: "https://cdn.example.com/alpine-flight.mp4" }],
            metadata: { seed: 7 },
            _internal: { provider: "ltx" },
          };
        },
      }
    );

    assert.equal(res.status, "success");
    assert.equal(res.video_url, "https://cdn.example.com/alpine-flight.mp4");
    assert.deepEqual(res.assets, [{ url: "https://cdn.example.com/alpine-flight.mp4" }]);
    assert.deepEqual(res.metadata, {
      model: "ltx_2_3_fast",
      provider: "ltx",
      seed: 7,
    });

    assert.ok(capturedCall);
    assert.equal(capturedCall.modelId, "ltx_2_3_fast");
    assert.equal(capturedCall.prompt, "minimal alpine drone flight");
    assert.deepEqual(capturedCall.params, { prompt: "minimal alpine drone flight" });
    assert.equal("duration" in capturedCall.params, false);
    assert.equal("aspect_ratio" in capturedCall.params, false);
    assert.equal("input_image" in capturedCall.params, false);
    assert.equal("last_frame" in capturedCall.params, false);
    assert.equal("input_video" in capturedCall.params, false);

    // End-to-end check against real ltx_2_3_fast manifest: no hardcoded duration: 5 injected -> manifest default "8" applies
    let capturedLtxPayload = null;
    registerProviderRunner("ltx", async ({ payload }) => {
      capturedLtxPayload = payload;
      return {
        status: "completed",
        result: { video_url: "https://api.ltx.io/generated/default-8s.mp4" },
      };
    });
    try {
      const manifestRes = await VideoGenerateNode.execute(
        { model: "ltx_2_3_fast", prompt: "minimal ocean waves" },
        { runId: "run-ltx-minimal", nodeId: "gen_video", userId: "user-vid-minimal" }
      );
      assert.equal(manifestRes.status, "success");
      assert.equal(manifestRes.video_url, "https://api.ltx.io/generated/default-8s.mp4");
      assert.deepEqual(manifestRes.assets, [{ url: "https://api.ltx.io/generated/default-8s.mp4" }]);
      assert.equal(manifestRes.metadata.model, "ltx_2_3_fast");
      assert.equal(manifestRes.metadata.provider, "ltx");
      assert.equal(String(capturedLtxPayload.duration), "8");
    } finally {
      unregisterProviderRunner("ltx");
    }

    await assert.rejects(
      () => VideoGenerateNode.execute({ prompt: "missing model" }),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "model");
        return true;
      }
    );
    await assert.rejects(
      () => VideoGenerateNode.execute({ model: "   ", prompt: "blank model" }),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "model");
        return true;
      }
    );
    await assert.rejects(
      () => VideoGenerateNode.execute({ model: "ltx_2_3_fast", prompt: "   " }),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "prompt");
        return true;
      }
    );
  });

  it("base.video_generate forwards optional media URLs without clobbering explicit parameters", async () => {
    const calls = [];
    const ctx = {
      executeGeneration: async (call) => {
        calls.push(call);
        return { videos: ["https://cdn.example.com/forwarded.mp4"] };
      },
    };

    const trimmedRes = await VideoGenerateNode.execute(
      {
        model: "seedance_2_5",
        prompt: "smooth camera transition",
        start_image_url: "  https://cdn.example.com/start.png  ",
        end_image_url: "  https://cdn.example.com/end.png ",
        input_video_url: " https://cdn.example.com/source.mp4  ",
      },
      ctx
    );
    assert.equal(trimmedRes.status, "success");
    assert.equal(trimmedRes.video_url, "https://cdn.example.com/forwarded.mp4");
    assert.deepEqual(trimmedRes.assets, [{ url: "https://cdn.example.com/forwarded.mp4" }]);
    assert.deepEqual(calls[0].params, {
      prompt: "smooth camera transition",
      input_image: "https://cdn.example.com/start.png",
      last_frame: "https://cdn.example.com/end.png",
      input_video: "https://cdn.example.com/source.mp4",
    });

    await VideoGenerateNode.execute(
      {
        model: "seedance_2_5",
        prompt: "blank optional urls ignored",
        start_image_url: "   ",
        end_image_url: "",
        input_video_url: null,
      },
      ctx
    );
    assert.deepEqual(calls[1].params, { prompt: "blank optional urls ignored" });

    await VideoGenerateNode.execute(
      {
        model: "seedance_2_5",
        prompt: "explicit parameters win",
        start_image_url: "https://cdn.example.com/fallback-start.png",
        end_image_url: "https://cdn.example.com/fallback-end.png",
        input_video_url: "https://cdn.example.com/fallback-video.mp4",
        parameters: {
          input_image: "https://cdn.example.com/explicit-start.png",
          last_frame: "https://cdn.example.com/explicit-end.png",
          input_video: "https://cdn.example.com/explicit-video.mp4",
        },
      },
      ctx
    );
    assert.deepEqual(calls[2].params, {
      prompt: "explicit parameters win",
      input_image: "https://cdn.example.com/explicit-start.png",
      last_frame: "https://cdn.example.com/explicit-end.png",
      input_video: "https://cdn.example.com/explicit-video.mp4",
    });

    await VideoGenerateNode.execute(
      {
        model: "seedance_2_5",
        prompt: "blank explicit parameter falls back to top-level url",
        start_image_url: "https://cdn.example.com/fallback-start.png",
        parameters: { input_image: "   " },
      },
      ctx
    );
    assert.equal(calls[3].params.input_image, "https://cdn.example.com/fallback-start.png");
  });

  it("base.video_generate forwards model-specific settings via parameters", async () => {
    let capturedParams = null;
    const res = await VideoGenerateNode.execute(
      {
        model: "ltx_2_3_fast",
        prompt: "cinematic skyline flyover",
        parameters: {
          duration: 10,
          aspect_ratio: "9:16",
          resolution: "1080p",
          fps: 24,
          generate_audio: true,
          camera_motion: "dolly_in",
        },
      },
      {
        executeProvider: async (_model, params) => {
          capturedParams = params;
          return {
            assets: [{ url: "https://cdn.example.com/skyline.mp4" }],
            metadata: { duration: params.duration, aspect_ratio: params.aspect_ratio },
          };
        },
      }
    );

    assert.equal(res.status, "success");
    assert.equal(res.video_url, "https://cdn.example.com/skyline.mp4");
    assert.deepEqual(res.assets, [{ url: "https://cdn.example.com/skyline.mp4" }]);
    assert.deepEqual(capturedParams, {
      duration: 10,
      aspect_ratio: "9:16",
      resolution: "1080p",
      fps: 24,
      generate_audio: true,
      camera_motion: "dolly_in",
      prompt: "cinematic skyline flyover",
    });
    assert.equal(res.metadata.duration, 10);
    assert.equal(res.metadata.aspect_ratio, "9:16");
  });

  it("base.video_generate throws typed GenerationError on provider failure or empty video output instead of returning failed status", async () => {
    await assert.rejects(
      () =>
        VideoGenerateNode.execute(
          { model: "ltx_2_3_fast", prompt: "stormy sea waves" },
          {
            executeProvider: async () => {
              const err = new Error("Upstream video provider unavailable");
              err.statusCode = 503;
              throw err;
            },
          }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.ok(err instanceof GenerationUpstreamError);
        assert.equal(err.category, "UPSTREAM_FAULT");
        assert.equal(err.statusCode, 503);
        assert.equal(err.retryable, true);
        return true;
      }
    );

    await assert.rejects(
      () =>
        VideoGenerateNode.execute(
          { model: "ltx_2_3_fast", prompt: "empty video result" },
          {
            executeProvider: async () => ({ assets: [] }),
          }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.ok(err instanceof GenerationUpstreamError);
        assert.match(err.message, /Provider returned no video URL/i);
        return true;
      }
    );
  });

  it("base.image_generate exposes the simplified INPUT_TYPES and RETURN_TYPES contract", () => {
    assert.deepEqual(Object.keys(ImageGenerateNode.INPUT_TYPES.required).sort(), ["model", "prompt"]);
    assert.deepEqual(ImageGenerateNode.INPUT_TYPES.required, {
      model: { type: "STRING" },
      prompt: { type: "STRING" },
    });

    assert.deepEqual(Object.keys(ImageGenerateNode.INPUT_TYPES.optional).sort(), [
      "images",
      "operation",
      "parameters",
    ]);
    assert.deepEqual(ImageGenerateNode.INPUT_TYPES.optional, {
      images: { type: "ARRAY", default: [] },
      operation: { type: "STRING" },
      parameters: { type: "JSON", default: {} },
    });

    for (const removedKey of ["input_image_url", "reference_urls", "aspect_ratio", "width", "height", "count"]) {
      assert.equal(ImageGenerateNode.INPUT_TYPES.required[removedKey], undefined);
      assert.equal(ImageGenerateNode.INPUT_TYPES.optional[removedKey], undefined);
    }

    assert.deepEqual(ImageGenerateNode.RETURN_TYPES, {
      status: "STRING",
      image_url: "IMAGE_URL",
      assets: "ARRAY",
      metadata: "JSON",
    });
  });

  it("base.image_generate executes with minimal inputs (model + prompt only) and validates required fields", async () => {
    let capturedCall = null;
    const res = await ImageGenerateNode.execute(
      { model: "nanobana_2", prompt: "minimal alpine sunrise" },
      {
        userId: "user-minimal",
        executeGeneration: async (call) => {
          capturedCall = call;
          return {
            assets: [{ url: "https://cdn.example.com/alpine.png" }],
            metadata: { seed: 42 },
            _internal: { provider: "wavespeed" },
          };
        },
      }
    );

    assert.equal(res.status, "success");
    assert.equal(res.image_url, "https://cdn.example.com/alpine.png");
    assert.deepEqual(res.assets, [{ url: "https://cdn.example.com/alpine.png" }]);
    assert.deepEqual(res.metadata, {
      model: "nanobana_2",
      provider: "wavespeed",
      seed: 42,
    });

    assert.ok(capturedCall);
    assert.equal(capturedCall.modelId, "nanobana_2");
    assert.equal(capturedCall.prompt, "minimal alpine sunrise");
    assert.deepEqual(capturedCall.params, { prompt: "minimal alpine sunrise" });
    assert.equal("images" in capturedCall.params, false);
    assert.deepEqual(capturedCall.references, []);

    await assert.rejects(
      () => ImageGenerateNode.execute({ prompt: "missing model" }),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "model");
        return true;
      }
    );
    await assert.rejects(
      () => ImageGenerateNode.execute({ model: "nanobana_2", prompt: "   " }),
      (err) => {
        assert.ok(err instanceof GenerationValidationError);
        assert.equal(err.field, "prompt");
        return true;
      }
    );
  });

  it("base.image_generate throws GenerationValidationError when operation === 'edit' without a valid source image URL", async () => {
    for (const badInputs of [
      { model: "nanobana_2", operation: "edit", prompt: "Relight portrait" },
      { model: "nanobana_2", operation: "edit", prompt: "Relight portrait", images: [] },
      { model: "nanobana_2", operation: "edit", prompt: "Relight portrait", images: ["not-a-url"] },
      { model: "nanobana_2", operation: "EDIT", prompt: "Relight portrait", parameters: { input_image: "" } },
    ]) {
      await assert.rejects(
        () =>
          ImageGenerateNode.execute(badInputs, {
            executeGeneration: async () => {
              throw new Error("must not call provider when edit source image is missing");
            },
          }),
        (err) => {
          assert.ok(err instanceof GenerationValidationError);
          assert.equal(err.field, "images");
          assert.match(err.message, /requires a source image URL/i);
          return true;
        }
      );
    }

    // Estimate cost routes to edit pricing (12 at 1k, 18 at 2k, 26 at 4k) even when images are dynamic at compile time
    assert.equal(
      ImageGenerateNode.estimateCost({ model: "nanobana_2", operation: "edit", parameters: { resolution: "1k" } }),
      12
    );
    assert.equal(
      ImageGenerateNode.estimateCost({ model: "nanobana_2", operation: "edit", parameters: { resolution: "2k" } }),
      18
    );
    assert.equal(
      ImageGenerateNode.estimateCost({ model: "nanobana_2", operation: "edit", parameters: { resolution: "4k" } }),
      26
    );
  });

  it("base.image_generate normalizes images from an array or a single URL string into params.images", async () => {
    const calls = [];
    const ctx = {
      executeGeneration: async (call) => {
        calls.push(call);
        return { assets: [{ url: "https://cdn.example.com/edited.png" }] };
      },
    };

    const arrayRes = await ImageGenerateNode.execute(
      {
        model: "nanobana_2",
        prompt: "restyle portrait",
        images: [
          "  https://cdn.example.com/ref-1.png  ",
          "",
          null,
          { url: "https://cdn.example.com/ref-2.png" },
        ],
      },
      ctx
    );
    assert.equal(arrayRes.status, "success");
    assert.deepEqual(calls[0].params.images, [
      "https://cdn.example.com/ref-1.png",
      "https://cdn.example.com/ref-2.png",
    ]);
    assert.deepEqual(calls[0].references, [
      "https://cdn.example.com/ref-1.png",
      "https://cdn.example.com/ref-2.png",
    ]);

    const singleRes = await ImageGenerateNode.execute(
      {
        model: "nanobana_2",
        prompt: "add warm sunset lighting",
        images: "https://cdn.example.com/single-ref.png",
      },
      ctx
    );
    assert.equal(singleRes.status, "success");
    assert.deepEqual(calls[1].params.images, ["https://cdn.example.com/single-ref.png"]);
    assert.deepEqual(calls[1].references, ["https://cdn.example.com/single-ref.png"]);
  });

  it("base.image_generate forwards model-specific settings via parameters", async () => {
    let capturedParams = null;
    const res = await ImageGenerateNode.execute(
      {
        model: "nanobana_2",
        prompt: "cinematic skyline",
        parameters: {
          aspect_ratio: "16:9",
          resolution: "2k",
          output_format: "png",
        },
      },
      {
        executeProvider: async (_model, params) => {
          capturedParams = params;
          return {
            assets: [{ url: "https://cdn.example.com/skyline.png" }],
            metadata: { aspect_ratio: params.aspect_ratio, resolution: params.resolution },
          };
        },
      }
    );

    assert.equal(res.status, "success");
    assert.deepEqual(capturedParams, {
      aspect_ratio: "16:9",
      resolution: "2k",
      output_format: "png",
      prompt: "cinematic skyline",
    });
    assert.equal(res.metadata.aspect_ratio, "16:9");
    assert.equal(res.metadata.resolution, "2k");
  });

  it("base.image_generate throws typed GenerationError on provider failure instead of returning failed status", async () => {
    await assert.rejects(
      () =>
        ImageGenerateNode.execute(
          { model: "nanobana_2", prompt: "stormy sea" },
          {
            executeProvider: async () => {
              const err = new Error("Upstream provider unavailable");
              err.statusCode = 503;
              throw err;
            },
          }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.ok(err instanceof GenerationUpstreamError);
        assert.equal(err.category, "UPSTREAM_FAULT");
        assert.equal(err.statusCode, 503);
        assert.equal(err.retryable, true);
        return true;
      }
    );

    await assert.rejects(
      () =>
        ImageGenerateNode.execute(
          { model: "nanobana_2", prompt: "empty result" },
          {
            executeProvider: async () => ({ assets: [] }),
          }
        ),
      (err) => {
        assert.ok(err instanceof GenerationError);
        assert.ok(err instanceof GenerationUpstreamError);
        assert.match(err.message, /Provider returned no image URL/i);
        return true;
      }
    );
  });

  it("enforces fail-closed pricing via real #models/tools calculateCost and differentiates edit vs text-to-image pricing", () => {
    const t2iCost = ImageGenerateNode.estimateCost({
      model: "nanobana_2",
      parameters: { aspect_ratio: "1:1" },
    });
    assert.equal(t2iCost, 8);

    const t2iEmptyImagesCost = ImageGenerateNode.estimateCost({
      model: "nanobana_2",
      images: [],
    });
    assert.equal(t2iEmptyImagesCost, 8);

    const t2i2kCost = ImageGenerateNode.estimateCost({
      model: "nanobana_2",
      parameters: { resolution: "2k" },
    });
    assert.equal(t2i2kCost, 14);

    const editArrayCost = ImageGenerateNode.estimateCost({
      model: "nanobana_2",
      images: ["https://cdn.example.com/ref.png"],
    });
    assert.equal(editArrayCost, 12);

    const editSingleStringCost = ImageGenerateNode.estimateCost({
      model: "nanobana_2",
      images: "https://cdn.example.com/ref.png",
    });
    assert.equal(editSingleStringCost, 12);

    const edit2kCost = ImageGenerateNode.estimateCost({
      model: "nanobana_2",
      images: ["https://cdn.example.com/ref.png"],
      parameters: { resolution: "2k" },
    });
    assert.equal(edit2kCost, 18);

    // Video pricing: manifest defaults, parameters.duration, text-to-video vs image-to-video, video-to-video
    const ltxDefaultCost = VideoGenerateNode.estimateCost({ model: "ltx_2_3_fast" });
    assert.equal(ltxDefaultCost, 16);

    const ltx6sCost = VideoGenerateNode.estimateCost({
      model: "ltx_2_3_fast",
      parameters: { duration: 6 },
    });
    assert.equal(ltx6sCost, 12);

    const ltx8sCost = VideoGenerateNode.estimateCost({
      model: "ltx_2_3_fast",
      parameters: { duration: 8 },
    });
    assert.equal(ltx8sCost, 16);

    const ltx10sCost = VideoGenerateNode.estimateCost({
      model: "ltx_2_3_fast",
      parameters: { duration: 10 },
    });
    assert.equal(ltx10sCost, 20);

    const ltxI2vCost = VideoGenerateNode.estimateCost({
      model: "ltx_2_3_fast",
      start_image_url: "https://cdn.example.com/start.png",
      end_image_url: "https://cdn.example.com/end.png",
      parameters: { duration: 6 },
    });
    assert.equal(ltxI2vCost, 12);

    // Text-to-video vs image-to-video route pricing differentiation
    const seedanceT2vCost = VideoGenerateNode.estimateCost({ model: "seedance_2_5" });
    assert.equal(seedanceT2vCost, 40);

    const seedanceI2vCost = VideoGenerateNode.estimateCost({
      model: "seedance_2_5",
      start_image_url: "https://cdn.example.com/start.png",
    });
    assert.equal(seedanceI2vCost, 45);

    const seedanceStartEnd10sCost = VideoGenerateNode.estimateCost({
      model: "seedance_2_5",
      start_image_url: "https://cdn.example.com/start.png",
      end_image_url: "https://cdn.example.com/end.png",
      parameters: { duration: 10 },
    });
    assert.equal(seedanceStartEnd10sCost, 80);

    const wanT2vCost = VideoGenerateNode.estimateCost({ model: "wan_3_0" });
    assert.equal(wanT2vCost, 35);

    const wanI2vCost = VideoGenerateNode.estimateCost({
      model: "wan_3_0",
      start_image_url: "https://cdn.example.com/start.png",
    });
    assert.equal(wanI2vCost, 38);

    const retakeV2vCost = VideoGenerateNode.estimateCost({
      model: "ltx_retake",
      input_video_url: "https://cdn.example.com/input.mp4",
      parameters: { start_time: 0, duration: 4 },
    });
    assert.equal(retakeV2vCost, 22);

    const llmCost = LlmNode.estimateCost({ model: "gemini-3.1-flash-lite", prompt: "hello" });
    assert.equal(llmCost, 1);

    assert.throws(
      () => ImageGenerateNode.estimateCost({ prompt: "missing model" }),
      (err) => {
        assert.ok(err instanceof GenerationCompilationError);
        assert.match(err.message, /Missing required model/i);
        return true;
      }
    );
    assert.throws(
      () => VideoGenerateNode.estimateCost({ prompt: "missing model" }),
      (err) => {
        assert.ok(err instanceof GenerationCompilationError);
        assert.match(err.message, /Missing required model/i);
        return true;
      }
    );
    assert.throws(
      () => VideoGenerateNode.estimateCost({ model: "   ", prompt: "blank model" }),
      (err) => {
        assert.ok(err instanceof GenerationCompilationError);
        assert.match(err.message, /Missing required model/i);
        return true;
      }
    );
    assert.throws(
      () => ImageGenerateNode.estimateCost({ model: "non-existent-model-xyz" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
    assert.throws(
      () => VideoGenerateNode.estimateCost({ model: "non-existent-video-xyz" }),
      /not found|Unknown model|UnknownModelFamilyError/i
    );
  });

  it("base.save_media persists terminal outputs and character_description cleanly via #media/tools", async () => {
    const dbRecords = new Map([
      ["media-out-1", { id: "media-out-1", status: "processing", url: null }],
      [
        "media-77",
        {
          id: "media-77",
          status: "processing",
          url: null,
          generation_config: { prompt: "Original character concept" },
        },
      ],
    ]);
    const realShapeRepo = {
      findById: async (id) => dbRecords.get(id) || null,
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
    assert.equal(saved.status, "success");
    assert.equal(saved.saved_media.id, "media-out-1");
    assert.equal(saved.saved_media.status, "success");
    assert.equal(dbRecords.get("media-out-1").url, "https://cdn.example.com/final.png");

    const savedSheet = await SaveMediaNode.execute(
      {
        media_id: "media-77",
        asset_url: "https://cdn.example.com/sheet.png",
        final_prompt: "3-view turnaround sheet prompt",
        character_description: "3-view turnaround sheet description",
        metadata: { width: 1344, height: 768, model: "gpt-image-2" },
      },
      {
        mediaRepository: realShapeRepo,
      }
    );
    assert.equal(savedSheet.status, "success");
    assert.equal(savedSheet.saved_media.id, "media-77");
    assert.equal(savedSheet.saved_media.url, "https://cdn.example.com/sheet.png");
    assert.equal(dbRecords.get("media-77").status, "success");
    assert.equal(
      dbRecords.get("media-77").generation_config.character_description,
      "3-view turnaround sheet description"
    );

    // Rejects with HOLD_EXPIRED (409, retryable: false) when media record is already "failed"
    dbRecords.set("media-expired-99", {
      id: "media-expired-99",
      status: "failed",
      url: null,
    });
    await assert.rejects(
      () =>
        SaveMediaNode.execute(
          {
            media_id: "media-expired-99",
            asset_url: "https://cdn.example.com/late.png",
          },
          { mediaRepository: realShapeRepo }
        ),
      (err) => {
        assert.equal(err.code, "HOLD_EXPIRED");
        assert.equal(err.statusCode, 409);
        assert.equal(err.retryable, false);
        return true;
      }
    );
  });

  it("regression (Bug 1): base.save_media writes valid media_status enum ('success') and exposes { status, saved_media } contract", async () => {
    const VALID_MEDIA_STATUSES = new Set(["processing", "success", "failed"]);
    const rows = new Map([
      ["media-enum-1", { id: "media-enum-1", status: "processing", url: null }],
    ]);
    const strictEnumRepo = {
      findById: async (id) => rows.get(id) || null,
      updateFields: async (id, fields) => {
        if (fields.status !== undefined && !VALID_MEDIA_STATUSES.has(fields.status)) {
          throw new Error(`invalid input value for enum media_status: "${fields.status}"`);
        }
        const updated = { ...(rows.get(id) || { id }), ...fields };
        rows.set(id, updated);
        return updated;
      },
    };

    const res = await SaveMediaNode.execute(
      {
        media_id: "media-enum-1",
        asset_url: "https://cdn.example.com/enum-valid.png",
        final_prompt: "enum valid prompt",
      },
      { mediaRepository: strictEnumRepo }
    );

    assert.equal(res.status, "success");
    assert.equal(res.saved_media.status, "success");
    assert.equal(rows.get("media-enum-1").status, "success");
    assert.deepEqual(SaveMediaNode.RETURN_TYPES, {
      status: "STRING",
      saved_media: "JSON",
    });

    // Also verify ctx.markMediaStatus receives canonical "success"
    let capturedStatus = null;
    const hookRes = await SaveMediaNode.execute(
      {
        media_id: "media-enum-2",
        asset_url: "https://cdn.example.com/hook-valid.png",
      },
      {
        markMediaStatus: async (id, status, payload) => {
          capturedStatus = status;
          return { id, status, ...payload };
        },
      }
    );
    assert.equal(capturedStatus, "success");
    assert.equal(hookRes.status, "success");
    assert.equal(hookRes.saved_media.status, "success");
  });

  it("regression (Bug 2): base.save_media links completed media to parent workflow via real WorkflowMediaRepository object contract", async () => {
    const rows = new Map([
      [
        "media-link-1",
        {
          id: "media-link-1",
          workflow_id: "wf-parent-1",
          status: "processing",
          url: null,
        },
      ],
    ]);
    const mediaRepo = {
      findById: async (id) => rows.get(id) || null,
      updateFields: async (id, fields) => {
        const updated = { ...(rows.get(id) || { id }), ...fields };
        rows.set(id, updated);
        return updated;
      },
    };

    WorkflowMediaRepository.clearMemory();
    WorkflowMediaRepository.enableTestMemoryFallback();
    try {
      const realWfMediaRepo = new WorkflowMediaRepository();
      const res = await SaveMediaNode.execute(
        {
          media_id: "media-link-1",
          asset_url: "https://cdn.example.com/linked-sheet.png",
          media_role: "sheet",
          save_type: "character_sheet",
        },
        {
          workflowId: "wf-parent-1",
          mediaRepository: mediaRepo,
          workflowMediaRepository: realWfMediaRepo,
        }
      );

      const links = WorkflowMediaRepository.getMemoryStore();
      assert.equal(
        links.length,
        1,
        "Expected WorkflowMediaRepository.linkMedia to create a workflow_media link record"
      );
      assert.equal(links[0].workflow_id, "wf-parent-1");
      assert.equal(links[0].media_id, "media-link-1");
      assert.equal(links[0].role, "sheet");
      assert.equal(res.status, "success");
      assert.equal(rows.get("media-link-1").status, "success");
    } finally {
      WorkflowMediaRepository.clearMemory();
      WorkflowMediaRepository.disableTestMemoryFallback();
    }
  });

  it("Layer 3/4 alignment (Problem #1): base.save_media uploads external URL via { uploaded: [...] }, saves real width/height + generation_config, skips own-storage URLs, and discards storage on DB commit failure", async () => {
    const { envConfig } = await import("#shared");
    const uploadCalls = [];
    const discardedKeys = [];

    const mockUploadService = {
      upload: async (args) => {
        uploadCalls.push(args);
        return {
          uploaded: [
            {
              url: "https://storage.supabase.test/storage/v1/object/public/media/u1/uploads/perm.webp",
              storageKey: "u1/uploads/perm.webp",
              width: 1536,
              height: 1024,
              ratio: "3:2",
            },
          ],
        };
      },
      discard: async (keys) => {
        discardedKeys.push(...keys);
      },
    };

    const rows = new Map([
      [
        "media-ext-1",
        {
          id: "media-ext-1",
          workflow_id: "wf-ext-1",
          status: "processing",
          url: null,
          width: 1024,
          height: 1024,
          generation_config: {
            prompt: "relight portrait",
            model: "nanobana_2",
            edit_type: "relight",
            source_media_id: "media-orig-1",
          },
        },
      ],
      [
        "media-ext-2",
        {
          id: "media-ext-2",
          workflow_id: "wf-ext-1",
          status: "processing",
          url: null,
          width: 1024,
          height: 1024,
        },
      ],
      [
        "media-ext-failed",
        {
          id: "media-ext-failed",
          workflow_id: "wf-ext-1",
          status: "failed",
          url: null,
        },
      ],
    ]);

    const mediaRepo = {
      findById: async (id) => rows.get(id) || null,
      updateMedia: async (id, fields) => {
        const updated = { ...(rows.get(id) || { id }), ...fields };
        rows.set(id, updated);
        return updated;
      },
    };

    // 1. External WaveSpeed URL -> uploads via { uploaded: [...] }, commits permanent URL + real 1536x1024 + preserves generation_config
    //    Also confirms SaveMediaNode itself has zero holdExpired logic (Layer 2 owns holdExpired)
    const res1 = await SaveMediaNode.execute(
      {
        media_id: "media-ext-1",
        asset_url: "https://d1q70pf5vjeyhc.cloudfront.net/temp-wavespeed-out.png",
        final_prompt: "Relit portrait with warm rim light",
        metadata: { provider: "wavespeed", model: "nanobana_2" },
        save_type: "workflow_output",
      },
      {
        userId: "user-ext-1",
        workflowId: "wf-ext-1",
        useExternalPersistence: true,
        mediaRepository: mediaRepo,
        mediaUploadService: mockUploadService,
      }
    );

    assert.equal(uploadCalls.length, 1);
    assert.equal(res1.status, "success");
    assert.equal(
      res1.saved_media.url,
      "https://storage.supabase.test/storage/v1/object/public/media/u1/uploads/perm.webp"
    );
    const savedRow = rows.get("media-ext-1");
    assert.equal(savedRow.width, 1536);
    assert.equal(savedRow.height, 1024);
    assert.equal(savedRow.generation_config.source_media_id, "media-orig-1");
    assert.equal(savedRow.generation_config.edit_type, "relight");
    assert.equal(savedRow.generation_config.prompt_optimized, "Relit portrait with warm rim light");
    assert.equal(savedRow.generation_config.provider, "wavespeed");

    // 2. Idempotent skip when asset_url is already in our own Supabase Storage
    const ownStoragePrefix = (envConfig.rawSupabaseUrl || "").trim().replace(/\/+$/, "");
    if (ownStoragePrefix) {
      const ownUrl = `${ownStoragePrefix}/storage/v1/object/public/media/u1/uploads/already-saved.png`;
      const uploadsBefore = uploadCalls.length;
      const resOwn = await SaveMediaNode.execute(
        { media_id: "media-ext-2", asset_url: ownUrl },
        {
          userId: "user-ext-1",
          useExternalPersistence: true,
          mediaRepository: mediaRepo,
          mediaUploadService: mockUploadService,
        }
      );
      assert.equal(uploadCalls.length, uploadsBefore, "Own Supabase Storage URL must skip re-upload");
      assert.equal(resOwn.saved_media.url, ownUrl);
    }

    // 3. Pre-upload fail-closed guard when placeholder is already failed (zero wasted upload)
    const uploadsBeforeFail = uploadCalls.length;
    await assert.rejects(
      () =>
        SaveMediaNode.execute(
          { media_id: "media-ext-failed", asset_url: "https://cdn.example.com/late.png" },
          {
            userId: "user-ext-1",
            useExternalPersistence: true,
            mediaRepository: mediaRepo,
            mediaUploadService: mockUploadService,
          }
        ),
      (err) => err.code === "HOLD_EXPIRED" && err.statusCode === 409
    );
    assert.equal(uploadCalls.length, uploadsBeforeFail, "Already-failed placeholder must fail before uploading");

    // 4. Compensating discard([storageKey]) when DB commit fails after storage upload
    rows.set("media-ext-race", { id: "media-ext-race", status: "processing", url: null });
    let findCount = 0;
    const raceMediaRepo = {
      findById: async (id) => {
        findCount++;
        // First read (pre-check) sees processing; second read (inside completeMedia) sees Reaper marked failed!
        if (findCount === 1) return { id, status: "processing", url: null };
        return { id, status: "failed", hold_expired: true, url: null };
      },
      updateMedia: async () => {
        throw new Error("updateMedia must not be called after HOLD_EXPIRED race");
      },
    };

    await assert.rejects(
      () =>
        SaveMediaNode.execute(
          { media_id: "media-ext-race", asset_url: "https://d1q70pf5vjeyhc.cloudfront.net/race.png" },
          {
            userId: "user-ext-1",
            useExternalPersistence: true,
            mediaRepository: raceMediaRepo,
            mediaUploadService: mockUploadService,
          }
        ),
      (err) => err.code === "HOLD_EXPIRED" && err.statusCode === 409
    );
    assert.deepEqual(
      discardedKeys,
      ["u1/uploads/perm.webp"],
      "Uploaded storage object must be discarded immediately when completeMedia fails"
    );
  });
});
