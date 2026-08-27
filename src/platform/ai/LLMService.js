/**
 * LLMService.js
 * Unified Multimodal Vision & Text LLM Service.
 * Powered 100% via the central Models Management System (src/models/index.js)
 * running Google Gemini 2.0 Flash.
 */

import { run } from "../../models/index.js";

export class LLMService {
  /**
   * General LLM execution method (supports text + vision + JSON output)
   *
   * @param {Object} options
   * @param {string} options.prompt - Main user/task prompt
   * @param {string} [options.systemInstruction] - System prompt / role instructions
   * @param {string[]} [options.images] - Array of Base64 or image URLs
   * @param {boolean} [options.jsonMode=false] - Whether output should be parsed as JSON
   * @returns {Promise<{ raw: string, json?: object, model: string }>}
   */
  async generate({ prompt, systemInstruction = "", images = [], jsonMode = false }) {
    const fullPromptText = systemInstruction
      ? `${systemInstruction}\n\n${prompt}`
      : prompt;

    const messages = [{ role: "user", content: fullPromptText }];

    const runResult = await run("gemini-2-0-flash", "chat_completion", {
      messages,
      images,
      temperature: 0.4,
    });

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
        console.warn("[LLMService] Failed to parse JSON output:", jsonErr.message);
      }
    }

    return {
      raw: rawOutput,
      json: jsonResult,
      model: runResult.metadata?.deploymentUsed || "gemini-2-0-flash",
    };
  }
}

export const llmService = new LLMService();
