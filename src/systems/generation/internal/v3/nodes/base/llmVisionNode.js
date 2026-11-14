import { executeLLM, calculateCost } from "#models/tools";
import { GenerationValidationError, GenerationUpstreamError } from "../../../errors.js";

/**
 * LlmVisionNode (`base.llm_vision`)
 *
 * Multimodal vision analysis node (e.g., character sheet layout engineering,
 * product inspection, or motion prompt generation from reference frames) via `#models/tools`.
 */
export const LlmVisionNode = {
  type: "base.llm_vision",
  category: "llm",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      prompt: { type: "STRING" },
    },
    optional: {
      images: { type: "ARRAY", default: [] },
      image_url: { type: "IMAGE_URL" },
      model: { type: "STRING", default: "gemini-3.1-flash-lite" },
      system_instruction: { type: "STRING", default: "" },
      json_mode: { type: "BOOLEAN", default: false },
    },
  },

  RETURN_TYPES: {
    text: "STRING",
    json: "JSON",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1000,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    const model = plannedInputs.model || "gemini-3.1-flash-lite";
    const res = calculateCost(model, { prompt: plannedInputs.prompt || "analyze" });
    const amount =
      typeof res === "object" && res !== null
        ? Number(res.amount ?? res.totalCredits ?? res.credits ?? 0)
        : Number(res ?? 0);
    if (Number.isNaN(amount) || !Number.isFinite(amount) || amount < 0) {
      throw new GenerationValidationError(`Invalid cost calculation for LLM vision model "${model}"`);
    }
    return amount;
  },

  async execute(inputs, ctx = {}) {
    const prompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
    if (!prompt) {
      throw new GenerationValidationError("prompt is required for base.llm_vision", { field: "prompt" });
    }

    const images = [];
    if (typeof inputs.image_url === "string" && inputs.image_url.trim()) {
      images.push(inputs.image_url.trim());
    }
    if (Array.isArray(inputs.images)) {
      for (const img of inputs.images) {
        const url = typeof img === "string" ? img : img?.url;
        if (url && !images.includes(url)) {
          images.push(url);
        }
      }
    }

    const llmFn = ctx.executeLLM || executeLLM;
    const jsonMode = Boolean(inputs.json_mode);

    let res;
    try {
      res = await llmFn({
        model: inputs.model || "gemini-3.1-flash-lite",
        prompt,
        systemInstruction: inputs.system_instruction || "",
        images,
        jsonMode,
        userId: ctx.userId || null,
      });
    } catch (err) {
      throw new GenerationUpstreamError(`LLM vision analysis failed: ${err.message}`, {
        context: { model: inputs.model, cause: err.message },
      });
    }

    const text =
      (typeof res?.content === "string" && res.content.trim()) ||
      (typeof res?.raw === "string" && res.raw.trim()) ||
      (typeof res?.json?.description === "string" && res.json.description.trim()) ||
      (typeof res?.json?.prompt === "string" && res.json.prompt.trim()) ||
      prompt;

    return {
      text,
      json: res?.json ?? { prompt: text, description: text },
      metadata: {
        model: res?.model || inputs.model || "gemini-3.1-flash-lite",
        imagesCount: images.length,
        durationMs: res?.durationMs || 0,
      },
    };
  },
};

export default LlmVisionNode;
