import { executeLLM, calculateCost } from "#models/tools";
import {
  WorkflowValidationError,
  WorkflowUpstreamError,
  WorkflowSafetyError,
} from "../../errors.js";
import {
  extractNodeCostAmount,
  normalizeImages,
  normalizeModelInvocationError,
} from "./mediaNodeHelpers.js";
import {
  LLM_SKILLS_REGISTRY,
  buildUnifiedLlmInstruction,
} from "../../skills/index.js";

const DEFAULT_LLM_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_EMPTY_PROMPT_FALLBACK = "Process the attached images using the active skills.";

export const LlmNode = {
  type: "base.llm",
  category: "llm",
  OUTPUT_NODE: false,
  CACHEABLE: false,

  INPUT_TYPES: {
    required: {},
    optional: {
      model: { type: "STRING", default: DEFAULT_LLM_MODEL },
      prompt: { type: "STRING", default: "" },
      images: { type: "ARRAY", default: [] },
      skills: { type: "ARRAY", default: [] },
    },
  },

  RETURN_TYPES: {
    status: "STRING",
    text: "STRING",
    json: "JSON",
    metadata: "JSON",
  },

  estimateCost(plannedInputs = {}) {
    const model =
      (typeof plannedInputs.model === "string" && plannedInputs.model.trim()) ||
      DEFAULT_LLM_MODEL;
    const res = calculateCost(model, { prompt: plannedInputs.prompt || "llm" });
    return extractNodeCostAmount(res, model, "base.llm");
  },

  async execute(inputs = {}, ctx = {}) {
    const safeInputs = inputs && typeof inputs === "object" ? inputs : {};
    const rawPrompt = typeof safeInputs.prompt === "string" ? safeInputs.prompt.trim() : "";
    const images = normalizeImages(safeInputs.images);
    const skills = safeInputs.skills === undefined ? [] : safeInputs.skills;

    if (!rawPrompt && images.length === 0) {
      throw new WorkflowValidationError(
        "At least one of prompt or images is required for base.llm",
        { field: "prompt" }
      );
    }

    const { systemInstruction, requiresSafety, useJsonMode } =
      buildUnifiedLlmInstruction(skills);

    const llmFn = ctx.executeLLM || executeLLM;
    const model =
      (typeof safeInputs.model === "string" && safeInputs.model.trim()) ||
      DEFAULT_LLM_MODEL;
    const rawTimeoutMs = safeInputs.timeout_ms ?? safeInputs.timeoutMs;
    const timeoutMs =
      typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
        ? Math.floor(rawTimeoutMs)
        : undefined;

    let res;
    try {
      res = await llmFn({
        model,
        prompt: rawPrompt || DEFAULT_EMPTY_PROMPT_FALLBACK,
        systemInstruction,
        images,
        jsonMode: useJsonMode,
        userId: ctx.userId || null,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(ctx.executeLLM ? {} : { maxRetries: 0 }),
      });
    } catch (err) {
      throw normalizeModelInvocationError(err, model, {
        requiresSafety,
        allowUserFault: false,
        messagePrefix: requiresSafety ? "" : "LLM execution failed: ",
      });
    }

    const parsed = res?.json && typeof res.json === "object" ? res.json : null;

    if (requiresSafety) {
      if (!parsed) {
        const contractErr = new WorkflowUpstreamError(
          "Safety check contract violation (fail-closed): unparseable JSON response from LLM",
          {
            code: "SAFETY_CHECK_FAILED",
            category: "UPSTREAM_FAULT",
            retryable: false,
          }
        );
        contractErr.code = "SAFETY_CHECK_FAILED";
        contractErr.is_safe = false;
        throw contractErr;
      }

      if (parsed.is_safe === false) {
        const reason = parsed.safety_reason || "Prompt violates content safety policy";
        throw new WorkflowSafetyError(reason, {
          field: "prompt",
          context: { is_safe: false, safety_reason: reason },
        });
      }
    }

    const text =
      (typeof parsed?.prompt === "string" && parsed.prompt.trim()) ||
      (typeof parsed?.final_prompt === "string" && parsed.final_prompt.trim()) ||
      (typeof parsed?.text === "string" && parsed.text.trim()) ||
      (typeof res?.content === "string" && res.content.trim()) ||
      (typeof res?.raw === "string" && res.raw.trim()) ||
      rawPrompt;

    const json = parsed || {};

    return {
      status: "success",
      text,
      json,
      metadata: {
        model: res?.model || model,
        skills,
        imagesCount: images.length,
        durationMs: res?.durationMs || 0,
      },
    };
  },
};

export { LLM_SKILLS_REGISTRY, buildUnifiedLlmInstruction };
export default LlmNode;
