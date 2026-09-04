import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ElementAnalysisService } from "../../src/domain/element/ElementAnalysisService.js";
import { llmService } from "../../src/platform/ai/LLMService.js";
import { supabase } from "../../lib/supabase.js";
import elementRepository from "../../src/db/ElementRepository.js";

describe("ElementAnalysisService Unit Tests", () => {
  let service;
  let originalAnalyzeVision;
  let originalElementRepoUpdate;
  let originalSupabaseFrom;

  beforeEach(() => {
    service = new ElementAnalysisService();
    originalAnalyzeVision = llmService.analyzeVision;
    originalElementRepoUpdate = elementRepository.update;
    originalSupabaseFrom = supabase.from;
  });

  afterEach(() => {
    llmService.analyzeVision = originalAnalyzeVision;
    elementRepository.update = originalElementRepoUpdate;
    supabase.from = originalSupabaseFrom;
  });

  describe("runVisionLLMAnalysis", () => {
    it("should pass character type prompt to llmService.analyzeVision for character mode", async () => {
      let capturedArgs = null;
      llmService.analyzeVision = async (args) => {
        capturedArgs = args;
        return {
          json: {
            description: "A cyberpunk female warrior with neon implants.",
            keywords: ["cyberpunk", "neon", "warrior", "scifi"],
          },
          raw: '{"description":"..."}',
        };
      };

      const result = await service.runVisionLLMAnalysis(
        ["https://example.com/character.jpg"],
        "character"
      );

      assert.ok(capturedArgs);
      assert.deepEqual(capturedArgs.images, ["https://example.com/character.jpg"]);
      assert.ok(capturedArgs.systemInstruction.includes("character design"));
      assert.equal(capturedArgs.jsonMode, true);
      assert.equal(result.description, "A cyberpunk female warrior with neon implants.");
      assert.deepEqual(result.keywords, ["cyberpunk", "neon", "warrior", "scifi"]);
    });

    it("should use appropriate type prompt for style, object, and fallback modes", async () => {
      let capturedPrompts = [];
      llmService.analyzeVision = async (args) => {
        capturedPrompts.push(args.systemInstruction);
        return { json: { description: "Parsed", keywords: ["test"] } };
      };

      await service.runVisionLLMAnalysis(["https://example.com/img.jpg"], "style");
      await service.runVisionLLMAnalysis(["https://example.com/img.jpg"], "object");
      await service.runVisionLLMAnalysis(["https://example.com/img.jpg"], "unknown_mode");

      assert.ok(capturedPrompts[0].includes("Visual Language Specialist"));
      assert.ok(capturedPrompts[1].includes("Product Design Analyst"));
      assert.ok(capturedPrompts[2].includes("elite AI Art Director"));
    });

    it("should provide safe fallbacks when json output is missing description or keywords", async () => {
      llmService.analyzeVision = async () => ({
        json: null,
        raw: "A raw description text from model",
      });

      const result = await service.runVisionLLMAnalysis(["https://example.com/img.jpg"], "object");
      assert.equal(result.description, "A raw description text from model");
      assert.deepEqual(result.keywords, []);
    });
  });

  describe("analyzeElement", () => {
    it("should throw an error when no reference images are provided and context has none", async () => {
      service.fetchWorkflowContext = async () => ({ urls: [], elementType: "object" });

      await assert.rejects(
        async () => {
          await service.analyzeElement({ imageUrls: [] });
        },
        /ElementAnalysisService: No reference images found for this element\./
      );
    });

    it("should analyze element with provided imageUrls and persist metadata when workflowId is present", async () => {
      let persisted = null;
      service.persistElementMetadata = async (wfId, meta) => {
        persisted = { wfId, meta };
      };

      llmService.analyzeVision = async () => ({
        json: {
          description: "Studio lighting character profile",
          keywords: ["studio", "portrait", "8k"],
        },
      });

      const response = await service.analyzeElement({
        workflowId: "wf-12345",
        imageUrls: ["https://example.com/ref1.png", "https://example.com/ref2.png"],
        elementType: "character",
      });

      assert.equal(response.success, true);
      assert.equal(response.description, "Studio lighting character profile");
      assert.deepEqual(response.keywords, ["studio", "portrait", "8k"]);
      assert.equal(response.workflowId, "wf-12345");
      assert.equal(response.elementType, "character");
      assert.ok(response.durationMs >= 0);

      assert.ok(persisted);
      assert.equal(persisted.wfId, "wf-12345");
      assert.equal(persisted.meta.description, "Studio lighting character profile");
    });

    it("should fetch workflow context if imageUrls array is empty", async () => {
      service.fetchWorkflowContext = async (projId, wfId) => {
        assert.equal(wfId, "wf-db-lookup");
        return {
          urls: ["https://example.com/db-image.png"],
          elementType: "style",
        };
      };

      service.persistElementMetadata = async () => {};

      llmService.analyzeVision = async () => ({
        json: {
          description: "Minimalist Bauhaus style",
          keywords: ["bauhaus", "minimalist"],
        },
      });

      const response = await service.analyzeElement({
        workflowId: "wf-db-lookup",
        imageUrls: [],
      });

      assert.equal(response.success, true);
      assert.equal(response.elementType, "style");
      assert.equal(response.description, "Minimalist Bauhaus style");
    });
  });

  describe("generateDescription legacy wrapper", () => {
    it("should wrap analyzeElement and return description string", async () => {
      service.analyzeElement = async ({ imageUrls, elementName, elementType }) => {
        assert.deepEqual(imageUrls, ["https://example.com/test.jpg"]);
        assert.equal(elementName, "TestElement");
        assert.equal(elementType, "object");
        return { description: "Legacy description string" };
      };

      const desc = await service.generateDescription({
        elementName: "TestElement",
        elementType: "object",
        references: ["https://example.com/test.jpg"],
      });

      assert.equal(desc, "Legacy description string");
    });
  });

  describe("fetchWorkflowContext", () => {
    it("should resolve deduplicated URLs from workflow and media queries", async () => {
      const mockWorkflow = {
        id: "wf-111",
        name: "test-wf",
        element_type: "character",
        metadata: { elementType: "character" },
      };

      const mockMedia = [
        {
          id: "m-1",
          url: "https://example.com/img1.png",
          file_url: null,
          generation_config: {
            references: [{ url: "https://example.com/ref-a.png" }, { src: "https://example.com/img1.png" }],
          },
        },
        {
          id: "m-2",
          url: null,
          file_url: "https://example.com/img2.png",
          generation_config: null,
        },
      ];

      supabase.from = (table) => {
        if (table === "workflow") {
          return {
            select: () => ({
              or: () => ({
                single: async () => ({ data: mockWorkflow, error: null }),
              }),
            }),
          };
        }
        if (table === "media") {
          return {
            select: () => ({
              or: async () => ({ data: mockMedia, error: null }),
            }),
          };
        }
      };

      const context = await service.fetchWorkflowContext(null, "wf-111");

      assert.equal(context.elementType, "character");
      assert.equal(context.urls.length, 3);
      assert.ok(context.urls.includes("https://example.com/ref-a.png"));
      assert.ok(context.urls.includes("https://example.com/img1.png"));
      assert.ok(context.urls.includes("https://example.com/img2.png"));
    });

    it("should gracefully catch errors and return empty context", async () => {
      supabase.from = () => {
        throw new Error("Supabase connection offline");
      };

      const context = await service.fetchWorkflowContext(null, "wf-err");
      assert.deepEqual(context, { urls: [], elementType: "object" });
    });
  });

  describe("persistElementMetadata & editElement", () => {
    it("should update both workflow and element tables during persistElementMetadata", async () => {
      let wfUpdated = null;
      let repoUpdated = null;

      supabase.from = (table) => {
        assert.equal(table, "workflow");
        return {
          select: () => ({
            or: () => ({
              maybeSingle: async () => ({
                data: { id: "wf-222", metadata: { existingKey: "existingValue" } },
                error: null,
              }),
            }),
          }),
          update: (patch) => ({
            eq: async (col, val) => {
              wfUpdated = { col, val, patch };
              return { error: null };
            },
          }),
        };
      };

      elementRepository.update = async (id, patch) => {
        repoUpdated = { id, patch };
        return { id, ...patch };
      };

      await service.persistElementMetadata("wf-222", {
        description: "New visual DNA",
        keywords: ["dna", "visual"],
      });

      assert.ok(wfUpdated);
      assert.equal(wfUpdated.val, "wf-222");
      assert.equal(wfUpdated.patch.metadata.description, "New visual DNA");
      assert.deepEqual(wfUpdated.patch.metadata.keywords, ["dna", "visual"]);
      assert.equal(wfUpdated.patch.metadata.existingKey, "existingValue");

      assert.ok(repoUpdated);
      assert.equal(repoUpdated.id, "wf-222");
      assert.equal(repoUpdated.patch.description, "New visual DNA");
    });

    it("should edit element metadata and update both elementRepository and workflow table", async () => {
      let elementPatchApplied = null;
      let workflowPatchApplied = null;

      elementRepository.update = async (id, patch) => {
        elementPatchApplied = { id, patch };
        return { id, ...patch };
      };

      supabase.from = (table) => {
        assert.equal(table, "workflow");
        return {
          select: () => ({
            or: () => ({
              maybeSingle: async () => ({
                data: { id: "elem-333", metadata: { foo: "bar" } },
                error: null,
              }),
            }),
          }),
          update: (patch) => ({
            eq: async (col, val) => {
              workflowPatchApplied = { col, val, patch };
              return { error: null };
            },
          }),
        };
      };

      const result = await service.editElement("elem-333", {
        name: "Updated Name",
        description: "Updated Description",
        keywords: ["kw1", "kw2"],
        element_type: "character",
      });

      assert.equal(result.success, true);
      assert.equal(result.element.name, "Updated Name");
      assert.ok(elementPatchApplied);
      assert.equal(elementPatchApplied.id, "elem-333");
      assert.equal(elementPatchApplied.patch.name, "Updated Name");

      assert.ok(workflowPatchApplied);
      assert.equal(workflowPatchApplied.val, "elem-333");
      assert.equal(workflowPatchApplied.patch.display_name, "Updated Name");
      assert.equal(workflowPatchApplied.patch.element_type, "character");
      assert.equal(workflowPatchApplied.patch.metadata.description, "Updated Description");
    });
  });
});
