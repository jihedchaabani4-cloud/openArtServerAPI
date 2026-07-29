/**
 * LLMService.js
 * Unified, general-purpose LLM Provider & Client Service for Express Backend.
 * Handles text prompts, multimodal image inputs (Base64/URLs), system instructions,
 * JSON schema formatting, with built-in Gemini 3.1 Flash Lite + Groq Vision Fallback.
 */

const geminiApiKey = process.env.GEMINI_API_KEY || "";
const groqApiKey = process.env.GROQ_API_KEY || "";

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
    let lastGroqError = "";

    // ── Attempt 1: Gemini 3.1 Flash Lite ───────────────────────────────────────
    if (geminiApiKey) {
      try {
        const parts = [{ text: fullPromptText }];
        imagePayloads.forEach((img) => {
          parts.push({
            inline_data: { mime_type: img.mimeType, data: img.data },
          });
        });

        console.log(`[LLMService] Calling Gemini API (gemini-3.1-flash-lite)...`);
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
            console.log("[LLMService] ✅ Gemini response received successfully.");
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
    }

    // ── Attempt 2: Groq Vision / LLM Fallback ───────────────────────────────────
    if (!rawOutput && groqApiKey) {
      console.warn(`[LLMService] Gemini failed (${lastGeminiError}). Falling back to Groq...`);
      try {
        const isVision = imagePayloads.length > 0;
        const groqModel = isVision ? "llama-3.2-11b-vision-preview" : "llama-3.3-70b-versatile";

        const contentParts = [{ type: "text", text: fullPromptText }];
        imagePayloads.forEach((img) => {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          });
        });

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqApiKey}`,
          },
          body: JSON.stringify({
            model: groqModel,
            messages: [{ role: "user", content: contentParts }],
            temperature: 0.2,
          }),
        });

        if (response.ok) {
          const resData = await response.json();
          const text = resData?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            rawOutput = text.trim();
            usedModel = groqModel;
            console.log(`[LLMService] ✅ Groq (${groqModel}) fallback succeeded!`);
          } else {
            lastGroqError = "Groq returned empty text";
          }
        } else {
          const errText = await response.text();
          lastGroqError = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
        }
      } catch (err) {
        lastGroqError = err.message;
      }
    }

    if (!rawOutput) {
      throw new Error(`LLMService: All AI providers failed. Gemini: "${lastGeminiError}", Groq: "${lastGroqError}".`);
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
