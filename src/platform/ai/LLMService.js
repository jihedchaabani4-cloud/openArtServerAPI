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

export const ALLOWED_INTERNAL_REASONS = Object.freeze([
  "internal-platform-llm",
  "internal-platform-moderation",
  "internal-prompt-optimization",
  "internal-system-test",
]);

export class LLMService {
  constructor({ defaultModel = "gemini-3.1-flash-lite" } = {}) {
    this.defaultModel = defaultModel;
    logger.debug({ defaultModel: this.defaultModel }, `[LLMService] Initialized with default model "${this.defaultModel}"`);
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
   * @param {string} [params.userId] - Authenticated user identifier (mandatory unless explicit internal reason)
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
    userId = null,
    options = {},
  }) {
    const startTime = performance.now();

    const resolvedUserId = userId || options.userId || null;
    const isInternal = Boolean(options.internal || options.isInternal);
    const internalReason = options.reason || null;

    // Enforce billing identity: require userId unless caller provides an explicit, approved internal platform flag
    if (!resolvedUserId) {
      if (!isInternal || !ALLOWED_INTERNAL_REASONS.includes(internalReason)) {
        throw new Error(
          `LLMService: userId is required for charged LLM calls unless explicitly authorized with an approved internal platform reason (allowed reasons: ${ALLOWED_INTERNAL_REASONS.join(", ")}).`
        );
      }
    }

    const fullPrompt = systemInstruction
      ? `${systemInstruction}\n\n${prompt}`
      : prompt;

    const messages = [{ role: "user", content: fullPrompt }];

    logger.debug(
      {
        model,
        promptLength: prompt?.length || 0,
        hasSystemInstruction: Boolean(systemInstruction),
        imagesCount: images.length,
        jsonMode,
        temperature,
        event: LogEvents.PROVIDER_REQUEST_STARTED,
      },
      `[LLMService] Request started for model "${model}" (images: ${images.length}, jsonMode: ${jsonMode})`
    );

    let result;
    try {
      // Strip request-controlled and caller-supplied financial flags to prevent tampering
      const {
        noCharge: _ignoredNoCharge,
        internal: _ignoredInternal,
        isInternal: _ignoredIsInternal,
        reason: _ignoredReason,
        ...cleanOptions
      } = options;

      const runOptions = resolvedUserId
        ? {
            ...cleanOptions,
            userId: resolvedUserId,
            noCharge: false,
          }
        : {
            ...cleanOptions,
            noCharge: true,
            reason: internalReason,
          };

      result = await run(
        model,
        {
          messages,
          images,
          temperature,
        },
        runOptions
      );
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      logger.error(
        {
          model,
          durationMs,
          error: err.message,
          code: err.code || "LLM_GENERATION_FAILED",
          statusCode: err.statusCode || 500,
          event: LogEvents.PROVIDER_REQUEST_FAILED,
        },
        `[LLMService] Request failed after ${durationMs}ms for model "${model}": ${err.message}`
      );
      throw err;
    }

    const durationMs = Math.round(performance.now() - startTime);
    const rawOutput = result.content || result.text || "";

    let jsonResult = null;
    if (jsonMode) {
      jsonResult = this.parseJSON(rawOutput);
    }

    logger.info(
      {
        model: result.metadata?.modelId || model,
        durationMs,
        outputLength: rawOutput.length,
        jsonParsed: Boolean(jsonResult),
        event: LogEvents.PROVIDER_REQUEST_COMPLETED,
      },
      `[LLMService] Completed in ${durationMs}ms for model "${model}"`
    );

    return {
      raw: rawOutput,
      content: rawOutput,
      json: jsonResult,
      model: result.metadata?.modelId || model,
      durationMs,
    };
  }

  /**
   * Helper: Text generation
   */
  async generateText({ prompt, systemInstruction = "", temperature = 0.7, model = this.defaultModel, userId = null, options = {} }) {
    logger.debug({ model, promptSnippet: prompt?.slice(0, 80) }, `[LLMService] generateText called`);
    const res = await this.generate({
      prompt,
      systemInstruction,
      temperature,
      model,
      userId: userId || options.userId,
      options,
    });
    return res.content;
  }

  /**
   * Helper: Structured JSON generation
   */
  async generateJSON({ prompt, systemInstruction = "", temperature = 0.4, model = this.defaultModel, userId = null, options = {} }) {
    logger.debug({ model, promptSnippet: prompt?.slice(0, 80) }, `[LLMService] generateJSON called`);
    const res = await this.generate({
      prompt,
      systemInstruction,
      jsonMode: true,
      temperature,
      model,
      userId: userId || options.userId,
      options,
    });
    return res.json || this.parseJSON(res.raw);
  }

  /**
   * Helper: Multimodal Vision analysis
   */
  async analyzeVision({ images = [], prompt, systemInstruction = "", jsonMode = true, model = this.defaultModel, userId = null, options = {} }) {
    logger.info(
      { model, imagesCount: images.length, promptSnippet: prompt?.slice(0, 80) },
      `[LLMService] analyzeVision called for ${images.length} image(s)`
    );
    return this.generate({
      prompt,
      systemInstruction,
      images: images.slice(0, 6),
      jsonMode,
      model,
      userId: userId || options.userId,
      options,
    });
  }

  /**
   * Robust JSON extraction from LLM text responses, stripping markdown blocks.
   */
  parseJSON(rawText = "") {
    if (!rawText) {
      logger.warn("[LLMService] Empty raw text passed to parseJSON");
      return null;
    }
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
      logger.warn({ err: err.message, snippet: rawText.slice(0, 100) }, `[LLMService] Failed to parse JSON: ${err.message}`);
      return null;
    }
  }
}

export const llmService = new LLMService();
export default llmService;
