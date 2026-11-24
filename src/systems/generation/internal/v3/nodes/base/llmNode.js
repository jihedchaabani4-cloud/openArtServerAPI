import { executeLLM, calculateCost } from "#models/tools";
import {
  GenerationError,
  GenerationValidationError,
  GenerationUpstreamError,
  GenerationSafetyError,
} from "../../../errors.js";
import { extractNodeCostAmount } from "./mediaNodeHelpers.js";
import {
  LLM_SKILLS_REGISTRY,
  buildUnifiedLlmInstruction,
} from "../../skills/index.js";

const DEFAULT_LLM_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_EMPTY_PROMPT_FALLBACK = "Process the attached images using the active skills.";

function normalizeImages(rawImages) {
  const items = Array.isArray(rawImages)
    ? rawImages
    : rawImages !== undefined && rawImages !== null
      ? [rawImages]
      : [];
  const urls = [];
  const seen = new Set();
  for (const item of items) {
    const raw = typeof item === "string" ? item : item?.url;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        urls.push(trimmed);
      }
    }
  }
  return urls;
}

/**
 * LlmNode (`base.llm`)
 *
 * Generic single-call LLM & Vision node driven exclusively by composable
 * `SKILL.md` skills with fail-closed safety guard enforcement.
 */
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

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1000,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
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
      throw new GenerationValidationError(
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
      });
    } catch (err) {
      if (err?.code === "BILLING_CONTEXT_MISSING") {
        throw err;
      }
      if (
        err?.code === "CONTENT_SAFETY_VIOLATION" ||
        err?.code === "PROVIDER_CONTENT_POLICY_ERROR" ||
        err?.is_safe === false ||
        /safety violation|content policy|nsfw/i.test(err?.message || "")
      ) {
        if (err instanceof GenerationError && err.code === "CONTENT_SAFETY_VIOLATION") {
          err.retryable = false;
          err.statusCode = 422;
          throw err;
        }
        throw new GenerationSafetyError(
          err?.message || "Prompt violates content safety policy",
          { field: "prompt" }
        );
      }

      const rawCode = String(err?.code || err?.errorCode || "").toUpperCase();
      const status = Number(err?.statusCode || err?.status || 0);
      const msg = err?.message || "";
      const isCircuitBreakerOpen = rawCode === "CIRCUIT_BREAKER_OPEN";
      const isProviderQuota = rawCode === "PROVIDER_QUOTA_EXCEEDED";
      const isRateLimit =
        !isProviderQuota &&
        (status === 429 ||
          err?.category === "RATE_LIMIT" ||
          rawCode === "RATE_LIMITED" ||
          rawCode === "RATE_LIMIT_EXCEEDED" ||
          rawCode === "PROVIDER_RATE_LIMITED" ||
          /rate limit|429/i.test(msg));
      const isTimeout =
        status === 504 ||
        status === 408 ||
        /TIMEOUT/i.test(rawCode) ||
        /timed out|timeout/i.test(msg);

      if (requiresSafety) {
        const isTransient =
          isCircuitBreakerOpen ||
          isRateLimit ||
          isTimeout ||
          isProviderQuota ||
          err?.retryable === true ||
          err?.category === "UPSTREAM_FAULT" ||
          rawCode === "PROVIDER_TRANSIENT_ERROR" ||
          rawCode === "PROVIDER_UNAVAILABLE" ||
          status === 502 ||
          status === 503;

        if (isTransient) {
          const category = isRateLimit ? "RATE_LIMIT" : "UPSTREAM_FAULT";
          const statusCode = isRateLimit
            ? 429
            : status === 503 || isCircuitBreakerOpen || isProviderQuota
              ? 503
              : 502;
          const unavailableErr = new GenerationUpstreamError(
            `Safety verification temporarily unavailable (fail-closed): ${msg}`,
            {
              code: "SAFETY_CHECK_UNAVAILABLE",
              category,
              statusCode,
              retryable: !isCircuitBreakerOpen && !isProviderQuota,
              context: {
                cause: msg,
                ...(rawCode ? { upstreamCode: rawCode } : {}),
              },
            }
          );
          unavailableErr.code = "SAFETY_CHECK_UNAVAILABLE";
          throw unavailableErr;
        }

        const failErr = new GenerationUpstreamError(
          `Safety verification failed (fail-closed): ${msg}`,
          {
            code: "SAFETY_CHECK_FAILED",
            category: "UPSTREAM_FAULT",
            statusCode: 502,
            retryable: false,
            context: { cause: msg },
          }
        );
        failErr.code = "SAFETY_CHECK_FAILED";
        failErr.is_safe = false;
        throw failErr;
      }

      const category =
        !isProviderQuota &&
        (isRateLimit || /quota/i.test(msg))
          ? "RATE_LIMIT"
          : "UPSTREAM_FAULT";
      throw new GenerationUpstreamError(`LLM execution failed: ${msg}`, {
        code:
          category === "RATE_LIMIT"
            ? "RATE_LIMIT_EXCEEDED"
            : err?.code || "GENERATION_UPSTREAM_ERROR",
        category,
        statusCode:
          category === "RATE_LIMIT"
            ? 429
            : status === 503 || isCircuitBreakerOpen || isProviderQuota
              ? 503
              : 502,
        retryable: !isCircuitBreakerOpen && !isProviderQuota,
        context: { model, cause: msg },
      });
    }

    const parsed = res?.json && typeof res.json === "object" ? res.json : null;

    // Safety Enforcement when a safety guard skill is active:
    // - Unparseable/non-JSON response still fails closed (`SAFETY_CHECK_FAILED`).
    // - Valid JSON defaults `is_safe` to `true` when omitted; blocks only on explicit `is_safe === false`.
    if (requiresSafety) {
      if (!parsed) {
        const contractErr = new GenerationUpstreamError(
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
        throw new GenerationSafetyError(reason, {
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
