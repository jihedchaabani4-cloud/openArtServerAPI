/**
 * LLMService.js
 * Central Platform Unified LLM & Multimodal Vision Service.
 *
 * Single Source of Truth for all LLM operations across the platform
 * (Element Analysis, LLM Workflow Nodes, Prompt Engineering, and Vision).
 * Backed 100% by the central Models Management System (src/models/index.js)
 * with Google Gemini 2.0 Flash as the default workhorse model.
 */

import { run } from "../../models/index.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const logger = createLogger("llm");

export class LLMService {
  constructor({ defaultModel = "gemini-2-0-flash" } = {}) {
    this.defaultModel = defaultModel;
  }

  /**
   * Core generation method (supports Text, Vision, and JSON parsing).
   *
   * @param {Object} params
   * @param {string} params.prompt - Main user prompt
   * @param {string} [params.systemInstruction=""] - System prompt / role directives
   * @param {string[]} [params.images=[]] - Array of Base64 or image URLs for multimodal vision
   * @param {boolean} [params.jsonMode=false] - Whether output should be parsed as JSON
   * @param {string} [params.model] - Model override (defaults to this.defaultModel)
   * @param {number} [params.temperature=0.4] - Sampling temperature
   * @param {Object} [params.options={}] - Extra runner options (e.g. sdkClient for testing)
   * @returns {Promise<{ raw: string, content: string, json?: object, model: string, durationMs: number }>}
   */
  async generate({
    prompt,
    systemInstruction = "",
    images = [],
    jsonMode = false,
    model = this.defaultModel,
    temperature = 0.4,
    options = {},
  }) {
    const startTime = performance.now();

    const fullPrompt = systemInstruction
      ? `${systemInstruction}\n\n${prompt}`
      : prompt;

    const messages = [{ role: "user", content: fullPrompt }];

    logger.debug(
      { model, event: LogEvents.PROVIDER_REQUEST_STARTED },
      `[LLMService] Request started for model "${model}"`
    );

    const result = await run(
      model,
      "chat_completion",
      {
        messages,
        images,
        temperature,
      },
      options
    );

    const durationMs = Math.round(performance.now() - startTime);
    const rawOutput = result.content || result.text || "";

    logger.info(
      {
        model,
        durationMs,
        event: LogEvents.PROVIDER_REQUEST_COMPLETED,
      },
      `[LLMService] Completed in ${durationMs}ms via ${result.metadata?.providerUsed || "google"}`
    );

    let jsonResult = null;
    if (jsonMode) {
      jsonResult = this.parseJSON(rawOutput);
    }

    return {
      raw: rawOutput,
      content: rawOutput,
      json: jsonResult,
      model: result.metadata?.providerModelId || result.metadata?.modelId || model,
      durationMs,
    };
  }

  /**
   * Helper: Text generation
   */
  async generateText({ prompt, systemInstruction = "", temperature = 0.7, model = this.defaultModel, options = {} }) {
    const res = await this.generate({
      prompt,
      systemInstruction,
      temperature,
      model,
      options,
    });
    return res.content;
  }

  /**
   * Helper: Structured JSON generation
   */
  async generateJSON({ prompt, systemInstruction = "", temperature = 0.4, model = this.defaultModel, options = {} }) {
    const res = await this.generate({
      prompt,
      systemInstruction,
      jsonMode: true,
      temperature,
      model,
      options,
    });
    return res.json || this.parseJSON(res.raw);
  }

  /**
   * Helper: Multimodal Vision analysis
   */
  async analyzeVision({ images = [], prompt, systemInstruction = "", jsonMode = true, model = this.defaultModel, options = {} }) {
    return this.generate({
      prompt,
      systemInstruction,
      images: images.slice(0, 6),
      jsonMode,
      model,
      options,
    });
  }

  /**
   * Robust JSON extraction from LLM text responses, stripping markdown blocks.
   */
  parseJSON(rawText = "") {
    if (!rawText) return null;
    try {
      let cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
      }
      return JSON.parse(cleaned);
    } catch (err) {
      logger.warn({ err: err.message }, `[LLMService] Failed to parse JSON: ${err.message}`);
      return null;
    }
  }
}

export const llmService = new LLMService();
export default llmService;
