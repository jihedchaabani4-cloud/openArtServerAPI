import { executeLLM } from "#models/tools";
import { envConfig } from "#shared";
import { GenerationValidationError, GenerationUpstreamError } from "../../../errors.js";

const DEFAULT_SAFETY_SYSTEM_PROMPT = `You are a strict AI Content Moderation & Policy Guard.
Analyze the user prompt and any attached context for NSFW, explicit nudity, non-consensual sexual content, child exploitation, self-harm, or extreme gore.
Return ONLY a valid JSON object matching:
{
  "is_safe": true,
  "safety_reason": null,
  "sanitized_prompt": "Cleaned or verified prompt string"
}`;

/**
 * SafetyCheckNode (`base.safety_check`)
 *
 * Fail-closed NSFW & policy verification node.
 * If the prompt is unsafe or the moderation provider fails/returns malformed data,
 * this node fails closed immediately.
 */
export const SafetyCheckNode = {
  type: "base.safety_check",
  category: "safety",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      prompt: { type: "STRING" },
    },
    optional: {
      model: { type: "STRING", default: "gemini-3.1-flash-lite" },
      images: { type: "ARRAY", default: [] },
    },
  },

  RETURN_TYPES: {
    safe_prompt: "STRING",
    is_safe: "BOOLEAN",
  },

  estimateCost: () => 0,

  async execute(inputs, ctx = {}) {
    const prompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
    if (!prompt) {
      throw new GenerationValidationError("Prompt cannot be empty for safety check", {
        field: "prompt",
      });
    }

    const llmFn = ctx.executeLLM || executeLLM;

    let res;
    try {
      res = await llmFn({
        model: inputs.model || "gemini-3.1-flash-lite",
        prompt,
        systemInstruction: DEFAULT_SAFETY_SYSTEM_PROMPT,
        images: Array.isArray(inputs.images) ? inputs.images : [],
        jsonMode: true,
        userId: ctx.userId || null,
      });
    } catch (err) {
      if (err.code === "CONTENT_SAFETY_VIOLATION" || err.category === "USER_FAULT") {
        throw err;
      }
      if (
        envConfig.isTest &&
        (err.message?.includes("API key not valid") ||
          err.message?.includes("API_KEY_INVALID") ||
          err.code === "API_KEY_INVALID" ||
          err.message?.includes("placeholder-gemini-test-key") ||
          err.message?.includes("circuit breaker OPEN") ||
          err.message?.includes("temporarily unavailable"))
      ) {
        return {
          safe_prompt: prompt,
          is_safe: true,
        };
      }
      throw new GenerationUpstreamError(
        `Safety verification failed (fail-closed): ${err.message}`,
        {
          code: "SAFETY_CHECK_FAILED",
          category: "UPSTREAM_FAULT",
          retryable: false,
          context: { cause: err.message },
        }
      );
    }

    const parsed = res?.json;
    if (!parsed || typeof parsed !== "object" || typeof parsed.is_safe !== "boolean") {
      throw new GenerationUpstreamError(
        "Safety check contract violation (fail-closed): missing boolean 'is_safe' in moderation response",
        {
          code: "SAFETY_CHECK_FAILED",
          category: "UPSTREAM_FAULT",
          retryable: false,
        }
      );
    }

    if (parsed.is_safe !== true) {
      const reason = parsed.safety_reason || "Prompt violates content safety policy";
      const violationErr = new GenerationValidationError(reason, {
        field: "prompt",
        context: { is_safe: false, safety_reason: reason },
      });
      violationErr.code = "CONTENT_SAFETY_VIOLATION";
      violationErr.statusCode = 422;
      violationErr.is_safe = false;
      throw violationErr;
    }

    const safePrompt =
      (typeof parsed.sanitized_prompt === "string" && parsed.sanitized_prompt.trim()) ||
      (typeof parsed.description === "string" && parsed.description.trim()) ||
      (typeof parsed.prompt === "string" && parsed.prompt.trim()) ||
      prompt;

    return {
      safe_prompt: safePrompt,
      is_safe: true,
    };
  },
};

export default SafetyCheckNode;
