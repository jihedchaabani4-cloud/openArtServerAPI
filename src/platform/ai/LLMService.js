/**
 * LLMService.js
 * Unified Multimodal Vision & Text LLM Service.
 * Powered 100% via the central Models Management System (src/models/index.js)
 * running Google Gemini 2.0 Flash.
 */

import { run } from "../../models/index.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const providerLogger = createLogger("provider");

export class LLMService {
  /**
   * General LLM execution method (supports text + vision + JSON output)
   *
   * @param {Object} options
   * @param {string} options.prompt - Main user/task prompt
   * @param {string} [options.systemInstruction] - System prompt / role instructions
   * @param {string[]} [options.images] - Array of Base64 or image URLs
   * @param {Object} [options.options] - Optional execution options (e.g. sdkClient mock)
   * @returns {Promise<{ raw: string, json?: object, model: string }>}
   */
  async generate({ prompt, systemInstruction = "", images = [], jsonMode = false, options = {} }) {
    const startTime = performance.now();
    const fullPromptText = systemInstruction
      ? `${systemInstruction}\n\n${prompt}`
      : prompt;

    const messages = [{ role: "user", content: fullPromptText }];

    providerLogger.debug(
      { provider: "gemini", model: "gemini-2-0-flash", event: LogEvents.PROVIDER_REQUEST_STARTED },
      "LLM Gemini 2.0 Flash request started"
    );

    const runResult = await run(
      "gemini-2-0-flash",
      "chat_completion",
      {
        messages,
        images,
        temperature: 0.4,
      },
      options
    );

    const durationMs = Math.round(performance.now() - startTime);
    providerLogger.info(
      {
        provider: "gemini",
        model: "gemini-2-0-flash",
        durationMs,
        event: LogEvents.PROVIDER_REQUEST_COMPLETED,
      },
      `LLM Gemini 2.0 Flash completed in ${durationMs}ms`
    );

    const rawOutput = runResult.content || "";

    // Parse JSON if requested
    let jsonResult = null;
    if (jsonMode) {
      try {
        let cleaned = rawOutput.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }
        jsonResult = JSON.parse(cleaned);
      } catch (jsonErr) {
        providerLogger.warn({ err: jsonErr }, `Failed to parse JSON output: ${jsonErr.message}`);
      }
    }

    return {
      raw: rawOutput,
      json: jsonResult,
      model: runResult.metadata?.providerModelId || runResult.metadata?.modelId || "gemini-2-0-flash",
    };
  }
}

export const llmService = new LLMService();
