/**
 * LLMService.js
 * Unified, general-purpose LLM Provider & Client Service for Express Backend.
 * Handles text prompts, multimodal image inputs (Base64/URLs), system instructions,
 * and JSON schema formatting via Gemini 3.1 Flash Lite with retry mechanism.
 */

const geminiApiKey = process.env.GEMINI_API_KEY || "";

export class LLMService {
  /**
   * Helper: Converts an HTTP URL or Base64 data URL into inline Base64 data payload.
   * @param {string} urlOrData
   * @returns {Promise<{ mimeType: string, data: string } | null>}
   */
  async prepareImagePayload(urlOrData) {
    if (!urlOrData || typeof urlOrData !== "string") return null;

    try {
      if (urlOrData.startsWith("data:")) {
        const matches = urlOrData.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (matches) {
          return { mimeType: matches[1], data: matches[2] };
        }
      }

      // If HTTP(S) URL, fetch and convert
      if (urlOrData.startsWith("http://") || urlOrData.startsWith("https://")) {
        const res = await fetch(urlOrData);
        if (!res.ok) return null;
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const mimeType = res.headers.get("content-type") || "image/jpeg";
        return { mimeType, data: buffer.toString("base64") };
      }

      return null;
    } catch (err) {
      console.warn("[LLMService] Image payload preparation error:", err.message);
      return null;
    }
  }

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
    // 1. Prepare image payloads
    const imagePayloads = (
      await Promise.all(images.map((img) => this.prepareImagePayload(img)))
    ).filter(Boolean);

    const fullPromptText = systemInstruction
      ? `${systemInstruction}\n\n${prompt}`
      : prompt;

    let rawOutput = null;
    let usedModel = "unknown";
    let lastGeminiError = "";
    const MAX_ATTEMPTS = 2;

    if (!geminiApiKey) {
      throw new Error("LLMService: GEMINI_API_KEY is not configured in environment variables.");
    }

    const parts = [{ text: fullPromptText }];
    imagePayloads.forEach((img) => {
      parts.push({
        inline_data: { mime_type: img.mimeType, data: img.data },
      });
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`[LLMService] Calling Gemini API (gemini-3.1-flash-lite) — Attempt ${attempt}/${MAX_ATTEMPTS}...`);
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts }] }),
          }
        );

        if (response.ok) {
          const resData = await response.json();
          const text = resData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text?.trim()) {
            rawOutput = text.trim();
            usedModel = "gemini-3.1-flash-lite";
            console.log(`[LLMService] ✅ Gemini response received successfully on attempt ${attempt}.`);
            break;
          } else {
            lastGeminiError = "Gemini returned empty text";
          }
        } else {
          const errText = await response.text();
          lastGeminiError = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
        }
      } catch (err) {
        lastGeminiError = err.message;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[LLMService] Attempt ${attempt} failed (${lastGeminiError}). Retrying in 1s...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!rawOutput) {
      throw new Error(`LLMService: Gemini API failed after ${MAX_ATTEMPTS} attempts. Error: "${lastGeminiError}".`);
    }

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
      model: usedModel,
    };
  }
}

export const llmService = new LLMService();
export default llmService;
