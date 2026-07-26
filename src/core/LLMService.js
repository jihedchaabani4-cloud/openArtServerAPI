/**
 * LLMService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic LLM abstraction layer.
 *
 * Usage:
 *   const llm = new LLMService();
 *
 *   // Text only
 *   const result = await llm.analyze({ prompt: "Write a description..." });
 *
 *   // With reference images (Vision)
 *   const result = await llm.analyze({
 *     prompt: "Analyze these images...",
 *     references: ["data:image/png;base64,...", "https://..."],
 *   });
 *
 *   // Force JSON output
 *   const json = await llm.analyze({ prompt: "...", mode: "json" });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts an image URL or base64 data URI into { mimeType, data } for Gemini.
 * Returns null if the image cannot be fetched.
 */
async function toGeminiInlinePart(url) {
  try {
    if (url.startsWith("data:")) {
      const [meta, data] = url.split(",");
      const mimeType = meta.match(/:(.*?);/)?.[1] || "image/jpeg";
      return { mimeType, data };
    }

    // Try to fetch from network
    const candidates = url.startsWith("http")
      ? [url, url.includes("localhost") ? url.replace("localhost", "127.0.0.1") : null].filter(Boolean)
      : [
          `http://127.0.0.1:5000${url.startsWith("/") ? url : `/${url}`}`,
          `http://localhost:5000${url.startsWith("/") ? url : `/${url}`}`,
        ];

    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate);
        if (res.ok) {
          const buffer = await res.arrayBuffer();
          const data = Buffer.from(buffer).toString("base64");
          const mimeType = res.headers.get("content-type") || "image/jpeg";
          return { mimeType, data };
        }
      } catch (_) {
        // try next candidate
      }
    }
    return null;
  } catch (err) {
    console.warn("[LLMService] Image conversion failed:", err.message);
    return null;
  }
}

// ── LLMService ────────────────────────────────────────────────────────────────

export class LLMService {
  /**
   * @param {object} [opts]
   * @param {string} [opts.geminiApiKey]   - Override GEMINI_API_KEY env var
   * @param {string} [opts.groqApiKey]     - Override GROQ_API_KEY env var
   * @param {string} [opts.geminiModel]    - Gemini text model (default: gemini-1.5-flash)
   * @param {string} [opts.groqVisionModel]- Groq vision model (default: llama-3.2-11b-vision-preview)
   */
  constructor(opts = {}) {
    this.geminiApiKey    = opts.geminiApiKey    || GEMINI_API_KEY;
    this.groqApiKey      = opts.groqApiKey      || GROQ_API_KEY;
    this.geminiModel     = opts.geminiModel     || "gemini-3.1-flash-lite";
    this.groqVisionModel = opts.groqVisionModel || "llama-3.2-11b-vision-preview";
  }

  /**
   * Main entry point. Analyzes a prompt (optionally with reference images).
   *
   * @param {object} params
   * @param {string}   params.prompt      - What you want from the LLM
   * @param {string[]} [params.references] - Optional image URLs or base64 data URIs
   * @param {"text"|"json"} [params.mode]  - Output format (default: "text")
   *
   * @returns {Promise<string|object>} LLM response (string or parsed JSON)
   */
  async analyze({ prompt, references = [], mode = "text" }) {
    const hasImages = Array.isArray(references) && references.length > 0;

    console.log(
      `[LLMService] analyze() — mode=${mode}, images=${references.length}, prompt length=${prompt.length}`
    );

    let result;

    if (hasImages) {
      // ── Vision Path ───────────────────────────────────────────────────────
      result = await this._visionAnalyze({ prompt, references, mode });
    } else {
      // ── Text Only Path ────────────────────────────────────────────────────
      result = await this._textAnalyze({ prompt, mode });
    }

    if (mode === "json") {
      if (typeof result === "object") return result;
      try {
        const match = result.match(/\{[\s\S]*\}/) || result.match(/\[[\s\S]*\]/);
        return JSON.parse(match ? match[0] : result);
      } catch (err) {
        console.warn("[LLMService] JSON parse failed, returning raw text:", err.message);
        return result;
      }
    }

    return result;
  }

  // ── Private: Vision (images + text) ──────────────────────────────────────

  async _visionAnalyze({ prompt, references, mode }) {
    // Attempt 1: Gemini Vision
    if (this.geminiApiKey) {
      try {
        const imageParts = (
          await Promise.all(references.slice(0, 6).map(toGeminiInlinePart))
        ).filter(Boolean);

        if (imageParts.length > 0) {
          const geminiParts = imageParts.map((p) => ({
            inline_data: { mime_type: p.mimeType, data: p.data },
          }));

          const body = {
            contents: [
              {
                parts: [{ text: prompt }, ...geminiParts],
              },
            ],
          };

          if (mode === "json") {
            body.generationConfig = { responseMimeType: "application/json" };
          }

          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          );

          if (res.ok) {
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text?.trim()) {
              console.log("[LLMService] Gemini Vision ✓");
              return text.trim();
            }
          } else {
            const errText = await res.text();
            console.warn("[LLMService] Gemini Vision failed:", res.status, errText.slice(0, 200));
          }
        }
      } catch (err) {
        console.warn("[LLMService] Gemini Vision error:", err.message);
      }
    }

    // Attempt 2: Groq Vision (llama-3.2-11b-vision-preview)
    if (this.groqApiKey) {
      try {
        const imageContentParts = references.slice(0, 6).map((url) => ({
          type: "image_url",
          image_url: {
            url: url.startsWith("data:") || url.startsWith("http") ? url : `data:image/jpeg;base64,${url}`,
          },
        }));

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.groqApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.groqVisionModel,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }, ...imageContentParts],
              },
            ],
            temperature: 0.7,
            max_tokens: 500,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            console.log("[LLMService] Groq Vision ✓");
            return text.trim();
          }
        } else {
          const errText = await res.text();
          console.warn("[LLMService] Groq Vision failed:", res.status, errText.slice(0, 200));
        }
      } catch (err) {
        console.warn("[LLMService] Groq Vision error:", err.message);
      }
    }

    throw new Error("[LLMService] All vision providers failed.");
  }

  // ── Private: Text only ───────────────────────────────────────────────────

  async _textAnalyze({ prompt, mode }) {
    // Attempt 1: Gemini Text
    if (this.geminiApiKey) {
      try {
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
        };
        if (mode === "json") {
          body.generationConfig = { responseMimeType: "application/json" };
        }

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text?.trim()) {
            console.log("[LLMService] Gemini Text ✓");
            return text.trim();
          }
        } else {
          const errText = await res.text();
          console.warn("[LLMService] Gemini Text failed:", res.status, errText.slice(0, 200));
        }
      } catch (err) {
        console.warn("[LLMService] Gemini Text error:", err.message);
      }
    }

    // Attempt 2: Groq Text (llama-3.3-70b-versatile)
    if (this.groqApiKey) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.groqApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 500,
            response_format: mode === "json" ? { type: "json_object" } : undefined,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text?.trim()) {
            console.log("[LLMService] Groq Text ✓");
            return text.trim();
          }
        } else {
          const errText = await res.text();
          console.warn("[LLMService] Groq Text failed:", res.status, errText.slice(0, 200));
        }
      } catch (err) {
        console.warn("[LLMService] Groq Text error:", err.message);
      }
    }

    throw new Error("[LLMService] All text providers failed.");
  }
}
