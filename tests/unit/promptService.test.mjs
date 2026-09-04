import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PromptService } from "../../src/platform/ai/PromptService.js";
import { llmService } from "../../src/platform/ai/LLMService.js";

describe("PromptService Unit Tests", () => {
  let promptService;
  let originalGenerateText;
  let originalGenerateJSON;

  beforeEach(() => {
    promptService = new PromptService();
    originalGenerateText = llmService.generateText;
    originalGenerateJSON = llmService.generateJSON;
  });

  afterEach(() => {
    llmService.generateText = originalGenerateText;
    llmService.generateJSON = originalGenerateJSON;
  });

  describe("complete and completeJSON delegation", () => {
    it("should delegate complete() to llmService.generateText with default gemini-2-0-flash", async () => {
      let capturedArgs = null;
      llmService.generateText = async (args) => {
        capturedArgs = args;
        return "Generated text completion";
      };

      const result = await promptService.complete({
        systemPrompt: "You are an assistant.",
        userPrompt: "Hello world",
        temperature: 0.8,
      });

      assert.equal(result, "Generated text completion");
      assert.equal(capturedArgs.prompt, "Hello world");
      assert.equal(capturedArgs.systemInstruction, "You are an assistant.");
      assert.equal(capturedArgs.temperature, 0.8);
      assert.equal(capturedArgs.model, "gemini-2-0-flash");
    });

    it("should delegate completeJSON() to llmService.generateJSON with default gemini-2-0-flash", async () => {
      let capturedArgs = null;
      llmService.generateJSON = async (args) => {
        capturedArgs = args;
        return { key: "value", number: 42 };
      };

      const result = await promptService.completeJSON({
        systemPrompt: "Return json",
        userPrompt: "Give me data",
        temperature: 0.3,
      });

      assert.deepEqual(result, { key: "value", number: 42 });
      assert.equal(capturedArgs.prompt, "Give me data");
      assert.equal(capturedArgs.systemInstruction, "Return json");
      assert.equal(capturedArgs.temperature, 0.3);
      assert.equal(capturedArgs.model, "gemini-2-0-flash");
    });
  });

  describe("checkPrompt", () => {
    it("should return parsed safety and translation metadata on valid response", async () => {
      llmService.generateJSON = async () => {
        return {
          is_safe: true,
          rejection_reason: null,
          language: "fr",
          translated_prompt: "A beautiful sunset over Paris",
        };
      };

      const res = await promptService.checkPrompt("Un beau coucher de soleil sur Paris");

      assert.equal(res.safe, true);
      assert.equal(res.reason, null);
      assert.equal(res.language, "fr");
      assert.equal(res.translatedPrompt, "A beautiful sunset over Paris");
    });

    it("should report unsafe prompt with rejection reason", async () => {
      llmService.generateJSON = async () => {
        return {
          is_safe: false,
          rejection_reason: "Explicit sexual content",
          language: "en",
          translated_prompt: "flagged prompt",
        };
      };

      const res = await promptService.checkPrompt("flagged prompt");

      assert.equal(res.safe, false);
      assert.equal(res.reason, "Explicit sexual content");
    });

    it("should fallback to safe default when LLM execution fails", async () => {
      llmService.generateJSON = async () => {
        throw new Error("Provider timeout 504");
      };

      const res = await promptService.checkPrompt("A cybernetic cat");

      assert.equal(res.safe, true);
      assert.equal(res.reason, null);
      assert.equal(res.language, "en");
      assert.equal(res.translatedPrompt, "A cybernetic cat");
    });
  });

  describe("optimizePrompt", () => {
    it("should return early when prompt is empty or whitespace without calling LLM", async () => {
      let called = false;
      llmService.generateJSON = async () => {
        called = true;
      };

      const res1 = await promptService.optimizePrompt("");
      const res2 = await promptService.optimizePrompt("   ");

      assert.equal(called, false);
      assert.equal(res1.optimized, "");
      assert.equal(res1.wasTranslated, false);
      assert.equal(res2.optimized, "   ");
      assert.equal(res2.wasEnhanced, false);
    });

    it("should parse LLM response and return enriched prompt with metadata", async () => {
      llmService.generateJSON = async () => {
        return {
          optimized_prompt: "A photorealistic ginger cat sitting on a cobblestone street in Tunis, golden hour cinematic lighting, 8k",
          original_language: "tn-darija",
          was_translated: true,
          was_enhanced: true,
          changes_summary: "Translated from Tunisian Darija and added cinematic lighting details",
        };
      };

      const res = await promptService.optimizePrompt("قطوس في زنقة تونس");

      assert.equal(res.optimized, "A photorealistic ginger cat sitting on a cobblestone street in Tunis, golden hour cinematic lighting, 8k");
      assert.equal(res.originalLanguage, "tn-darija");
      assert.equal(res.wasTranslated, true);
      assert.equal(res.wasEnhanced, true);
      assert.equal(res.changesSummary, "Translated from Tunisian Darija and added cinematic lighting details");
    });

    it("should return fallback object when optimizePrompt LLM call throws", async () => {
      llmService.generateJSON = async () => {
        throw new Error("LLM Rate Limit");
      };

      const res = await promptService.optimizePrompt("Cyberpunk samurai");

      assert.equal(res.optimized, "Cyberpunk samurai");
      assert.equal(res.originalLanguage, "unknown");
      assert.equal(res.wasTranslated, false);
      assert.equal(res.wasEnhanced, false);
      assert.equal(res.changesSummary, "none");
    });
  });

  describe("generateDnaFromPrompt & expandMinimalDna", () => {
    it("should generate character DNA from prompt", async () => {
      llmService.generateJSON = async () => ({
        gender: "female",
        age: 26,
        ethnicity: "Mediterranean",
        professional_prompt: "Portrait of 26yo Mediterranean woman",
      });

      const dna = await promptService.generateDnaFromPrompt("A 26yo Tunisian model in Sidi Bou Said");
      assert.ok(dna);
      assert.equal(dna.gender, "female");
      assert.equal(dna.age, 26);
    });

    it("should return null when generateDnaFromPrompt fails", async () => {
      llmService.generateJSON = async () => {
        throw new Error("API Failure");
      };

      const dna = await promptService.generateDnaFromPrompt("Invalid prompt");
      assert.equal(dna, null);
    });

    it("should expand minimal character selector into full DNA", async () => {
      llmService.generateJSON = async () => ({
        gender: "male",
        style: "cyberpunk",
        professional_prompt: "Cyberpunk rebel with neon hair",
      });

      const expanded = await promptService.expandMinimalDna({ gender: "male", style: "cyberpunk" });
      assert.ok(expanded);
      assert.equal(expanded.gender, "male");
      assert.equal(expanded.style, "cyberpunk");
    });

    it("should return null when expandMinimalDna fails", async () => {
      llmService.generateJSON = async () => {
        throw new Error("Expansion failure");
      };

      const expanded = await promptService.expandMinimalDna({ gender: "male" });
      assert.equal(expanded, null);
    });
  });

  describe("processEditIntent & generateProfessionalPromptFromDna", () => {
    it("should process edit intent and return surgical changes", async () => {
      llmService.generateJSON = async () => ({
        dna_changes: { hair_color: "platinum blonde" },
        change_prompt: "platinum blonde hair texture",
      });

      const res = await promptService.processEditIntent({ hair_color: "brown" }, "change hair to platinum blonde");
      assert.deepEqual(res.dna_changes, { hair_color: "platinum blonde" });
      assert.equal(res.change_prompt, "platinum blonde hair texture");
    });

    it("should return safe defaults when processEditIntent fails", async () => {
      llmService.generateJSON = async () => {
        throw new Error("Edit processing error");
      };

      const res = await promptService.processEditIntent({}, "make eyes blue");
      assert.deepEqual(res, { dna_changes: {}, change_prompt: "" });
    });

    it("should generate professional prompt from DNA", async () => {
      llmService.generateText = async () => "85mm lens portrait, sharp focus on eyes, soft bokeh";

      const prompt = await promptService.generateProfessionalPromptFromDna({ eye_color: "amber" }, "Studio lighting");
      assert.equal(prompt, "85mm lens portrait, sharp focus on eyes, soft bokeh");
    });

    it("should return empty string when generateProfessionalPromptFromDna fails", async () => {
      llmService.generateText = async () => {
        throw new Error("Generation error");
      };

      const prompt = await promptService.generateProfessionalPromptFromDna({});
      assert.equal(prompt, "");
    });
  });

  describe("generateNegativePrompt & generateSceneVariations", () => {
    it("should generate negative prompt string", async () => {
      llmService.generateJSON = async () => ({
        negative: "extra limbs, blurry, watermark",
      });

      const neg = await promptService.generateNegativePrompt("Heroic warrior");
      assert.equal(neg, "extra limbs, blurry, watermark");
    });

    it("should return default negative prompt string on failure", async () => {
      llmService.generateJSON = async () => {
        throw new Error("Negative prompt failure");
      };

      const neg = await promptService.generateNegativePrompt("Heroic warrior");
      assert.ok(neg.includes("low quality"));
      assert.ok(neg.includes("extra fingers"));
    });

    it("should generate scene variations", async () => {
      llmService.generateJSON = async () => ({
        variations: [
          "Close up portrait during sunset",
          "Wide angle shot at night",
        ],
      });

      const variations = await promptService.generateSceneVariations("A warrior standing", 2);
      assert.equal(variations.length, 2);
      assert.equal(variations[0], "Close up portrait during sunset");
    });

    it("should fallback to base prompt array when generateSceneVariations fails", async () => {
      llmService.generateJSON = async () => {
        throw new Error("Variations error");
      };

      const variations = await promptService.generateSceneVariations("Base character", 3);
      assert.equal(variations.length, 3);
      assert.deepEqual(variations, ["Base character", "Base character", "Base character"]);
    });
  });

  describe("End-to-End Execution via LLMService + Mock SDK Runner", () => {
    it("should run complete() through real LLMService calling mock Google SDK", async () => {
      const mockSdkClient = {
        models: {
          generateContent: async ({ model, contents }) => {
            assert.equal(model, "gemini-3.6-flash");
            return {
              text: "A cinematic hyper-realistic rendering of a desert citadel at dusk.",
            };
          },
        },
      };

      const result = await promptService.complete({
        systemPrompt: "You are a visual director.",
        userPrompt: "Desert citadel",
        options: { sdkClient: mockSdkClient },
      });

      assert.equal(result, "A cinematic hyper-realistic rendering of a desert citadel at dusk.");
    });
  });
});
