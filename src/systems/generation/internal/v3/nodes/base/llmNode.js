import { executeLLM, calculateCost } from "#models/tools";
import { GenerationValidationError, GenerationUpstreamError } from "../../../errors.js";
import { extractNodeCostAmount } from "./mediaNodeHelpers.js";

/**
 * Canonical Skills Registry for `base.llm`
 *
 * Combines multiple prompt intelligence tasks into a single LLM invocation
 * to minimize latency and token cost while guaranteeing fail-closed safety.
 */
export const LLM_SKILLS_REGISTRY = Object.freeze({
  "system-safety": {
    id: "system-safety",
    requiresSafetyCheck: true,
    requiresJson: true,
    instruction: `1. [SAFETY GUARD (FAIL-CLOSED)]:
   - Inspect the user prompt and any attached reference context/images for NSFW, explicit nudity, non-consensual sexual content, child exploitation, self-harm, or extreme gore.
   - Set "is_safe": true if safe, or "is_safe": false with a clear "safety_reason" if it violates policy.`,
  },
  translate: {
    id: "translate",
    requiresSafetyCheck: false,
    requiresJson: true,
    instruction: `2. [FAITHFUL TRANSLATION & TAG PRESERVATION]:
   - Translate the user prompt from Arabic dialect (Tunisian/Darija), French, or any other language into clear, faithful English suitable for AI media generation without adding unrequested objects.
   - CRITICAL: Preserve all @Name character/element tags and @image1..@imageN visual reference tags EXACTLY as written.`,
  },
  translation: {
    id: "translation",
    requiresSafetyCheck: false,
    requiresJson: true,
    instruction: `2. [FAITHFUL TRANSLATION & TAG PRESERVATION]:
   - Translate the user prompt from Arabic dialect (Tunisian/Darija), French, or any other language into clear, faithful English suitable for AI media generation without adding unrequested objects.
   - CRITICAL: Preserve all @Name character/element tags and @image1..@imageN visual reference tags EXACTLY as written.`,
  },
  "character-description": {
    id: "character-description",
    requiresSafetyCheck: false,
    requiresJson: true,
    instruction: `3. [CHARACTER TURNAROUND SHEET ENGINEERING]:
   - Engineer a consistent 3-view studio character turnaround sheet prompt (front view, side profile view, and back view on a neutral studio background) preserving all anatomical, facial, and outfit traits.
   - Populate "character_description" with the detailed character visual description and "character_title" with a short character title.`,
  },
  "json-output": {
    id: "json-output",
    requiresSafetyCheck: false,
    requiresJson: true,
    instruction: `4. [STRUCTURED JSON OUTPUT]:
   - Return ONLY a valid JSON object matching the requested schema.`,
  },
});

function normalizeSkillName(skill) {
  if (!skill || typeof skill !== "string") return "";
  const trimmed = skill.trim().toLowerCase().replace(/^llm\//, "");
  return trimmed;
}

/**
 * Builds a single unified system instruction from the active skills and optional custom_instruction.
 */
export function buildUnifiedLlmInstruction(skills = [], customInstruction = "") {
  const normalizedSkills = Array.isArray(skills)
    ? skills.map(normalizeSkillName).filter(Boolean)
    : [];

  const activeSpecs = [];
  const seen = new Set();

  for (const s of normalizedSkills) {
    const spec = LLM_SKILLS_REGISTRY[s];
    if (spec && !seen.has(spec.instruction)) {
      seen.add(spec.instruction);
      activeSpecs.push(spec);
    }
  }

  const requiresSafety = activeSpecs.some((s) => s.requiresSafetyCheck);
  const hasCharacterDesc = normalizedSkills.includes("character-description");

  const blocks = [
    "You are an AI Generation & Content Moderation Engine executing a unified single-call pipeline.",
  ];

  for (const spec of activeSpecs) {
    blocks.push(spec.instruction);
  }

  if (customInstruction && typeof customInstruction === "string" && customInstruction.trim()) {
    blocks.push(`[CUSTOM INSTRUCTION]:\n${customInstruction.trim()}`);
  }

  if (activeSpecs.length > 0 || requiresSafety) {
    blocks.push(
      `Return ONLY a valid JSON object with the following fields:
{
  "is_safe": true,
  "safety_reason": null,
  "prompt": "Translated and refined English prompt preserving all @Name and @imageN tags",
  "description": "${hasCharacterDesc ? "Detailed 3-view character turnaround sheet description" : "Translated and refined English prompt"}",
  "title": "Short descriptive title"
}`
    );
  }

  return {
    systemInstruction: blocks.join("\n\n"),
    requiresSafety,
    hasCharacterDesc,
    useJsonMode: activeSpecs.some((s) => s.requiresJson) || requiresSafety,
  };
}

/**
 * LlmNode (`base.llm`)
 *
 * Unified single-call LLM & Vision node with composable Skills (`system-safety`,
 * `translate` / `translation`, `character-description`, `json-output`).
 */
export const LlmNode = {
  type: "base.llm",
  category: "llm",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      prompt: { type: "STRING" },
    },
    optional: {
      model: { type: "STRING", default: "gemini-3.1-flash-lite" },
      images: { type: "ARRAY", default: [] },
      image_url: { type: "IMAGE_URL" },
      skills: { type: "ARRAY", default: ["system-safety", "translate"] },
      reference_guide: { type: "STRING", default: "" },
      custom_instruction: { type: "STRING", default: "" },
      system_instruction: { type: "STRING", default: "" },
      json_mode: { type: "BOOLEAN", default: true },
      schema: { type: "JSON" },
    },
  },

  RETURN_TYPES: {
    final_prompt: "STRING",
    safe_prompt: "STRING",
    text: "STRING",
    is_safe: "BOOLEAN",
    json: "JSON",
    character_description: "STRING",
    character_title: "STRING",
    metadata: "JSON",
  },

  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1000,
    retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
  },

  estimateCost(plannedInputs = {}) {
    const model = plannedInputs.model || "gemini-3.1-flash-lite";
    const res = calculateCost(model, { prompt: plannedInputs.prompt || "translate" });
    return extractNodeCostAmount(res, model, "base.llm");
  },

  async execute(inputs, ctx = {}) {
    const rawPrompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
    if (!rawPrompt) {
      throw new GenerationValidationError("prompt is required for base.llm", { field: "prompt" });
    }

    // Separate embedded [Reference Guide] from the prompt if present so we can cleanly re-attach it
    let promptBody = rawPrompt;
    let extractedGuide = typeof inputs.reference_guide === "string" ? inputs.reference_guide.trim() : "";
    const guideIdx = rawPrompt.indexOf("[Reference Guide]");
    if (guideIdx !== -1) {
      if (!extractedGuide) {
        extractedGuide = rawPrompt.slice(guideIdx).trim();
      }
      promptBody = rawPrompt.slice(0, guideIdx).trim() || rawPrompt;
    }

    const images = [];
    if (typeof inputs.image_url === "string" && inputs.image_url.trim()) {
      images.push(inputs.image_url.trim());
    }
    if (Array.isArray(inputs.images)) {
      for (const img of inputs.images) {
        const url = typeof img === "string" ? img.trim() : img?.url;
        if (url && !images.includes(url)) {
          images.push(url);
        }
      }
    }

    const skills = Array.isArray(inputs.skills) ? inputs.skills : ["system-safety", "translate"];
    const customInst =
      (typeof inputs.custom_instruction === "string" && inputs.custom_instruction.trim()) ||
      (typeof inputs.system_instruction === "string" && inputs.system_instruction.trim()) ||
      "";

    const { systemInstruction, requiresSafety, useJsonMode } = buildUnifiedLlmInstruction(skills, customInst);
    const jsonMode = inputs.json_mode !== undefined ? Boolean(inputs.json_mode) || requiresSafety : useJsonMode;

    const llmFn = ctx.executeLLM || executeLLM;

    let res;
    try {
      res = await llmFn({
        model: inputs.model || "gemini-3.1-flash-lite",
        prompt: rawPrompt,
        systemInstruction,
        images,
        jsonMode,
        schema: inputs.schema || null,
        userId: ctx.userId || null,
      });
    } catch (err) {
      if (err.code === "CONTENT_SAFETY_VIOLATION" || err.code === "BILLING_CONTEXT_MISSING") {
        throw err;
      }
      if (
        err.code === "PROVIDER_CONTENT_POLICY_ERROR" ||
        /safety violation|content policy|nsfw/i.test(err.message || "")
      ) {
        const violationErr = new GenerationValidationError(
          err.message || "Prompt violates content safety policy",
          { field: "prompt" }
        );
        violationErr.code = "CONTENT_SAFETY_VIOLATION";
        violationErr.category = "USER_FAULT";
        violationErr.statusCode = 422;
        violationErr.is_safe = false;
        throw violationErr;
      }
      if (requiresSafety) {
        const failErr = new GenerationUpstreamError(
          `Safety verification failed (fail-closed): ${err.message}`,
          {
            code: "SAFETY_CHECK_FAILED",
            category: "UPSTREAM_FAULT",
            retryable: false,
            context: { cause: err.message },
          }
        );
        failErr.code = "SAFETY_CHECK_FAILED";
        failErr.is_safe = false;
        throw failErr;
      }
      throw new GenerationUpstreamError(`LLM execution failed: ${err.message}`, {
        context: { model: inputs.model, cause: err.message },
      });
    }

    const parsed = res?.json;

    // Strict Fail-Closed Safety Enforcement when "system-safety" skill is active
    if (requiresSafety) {
      if (!parsed || typeof parsed !== "object" || typeof parsed.is_safe !== "boolean") {
        const contractErr = new GenerationUpstreamError(
          "Safety check contract violation (fail-closed): missing boolean 'is_safe' in LLM response",
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

      if (parsed.is_safe !== true) {
        const reason = parsed.safety_reason || "Prompt violates content safety policy";
        const violationErr = new GenerationValidationError(reason, {
          field: "prompt",
          context: { is_safe: false, safety_reason: reason },
        });
        violationErr.code = "CONTENT_SAFETY_VIOLATION";
        violationErr.category = "USER_FAULT";
        violationErr.statusCode = 422;
        violationErr.is_safe = false;
        throw violationErr;
      }
    }

    const translatedText =
      (typeof parsed?.final_prompt === "string" && parsed.final_prompt.trim()) ||
      (typeof parsed?.prompt === "string" && parsed.prompt.trim()) ||
      (typeof parsed?.sanitized_prompt === "string" && parsed.sanitized_prompt.trim()) ||
      (typeof parsed?.description === "string" && parsed.description.trim()) ||
      (typeof parsed?.character_description === "string" && parsed.character_description.trim()) ||
      (typeof res?.content === "string" && res.content.trim()) ||
      (typeof res?.raw === "string" && res.raw.trim()) ||
      promptBody;

    // Ensure [Reference Guide] is preserved in final_prompt if it was supplied or embedded
    let finalPrompt = translatedText;
    if (extractedGuide && !finalPrompt.includes("[Reference Guide]")) {
      finalPrompt = `${finalPrompt}\n\n${extractedGuide}`.trim();
    }

    const characterDescription =
      (typeof parsed?.character_description === "string" && parsed.character_description.trim()) ||
      (typeof parsed?.description === "string" && parsed.description.trim()) ||
      translatedText;

    const characterTitle =
      (typeof parsed?.character_title === "string" && parsed.character_title.trim()) ||
      (typeof parsed?.title === "string" && parsed.title.trim()) ||
      "Character";

    const jsonOutput =
      parsed && typeof parsed === "object"
        ? {
            is_safe: parsed.is_safe ?? true,
            prompt: finalPrompt,
            description: characterDescription,
            title: characterTitle,
            ...parsed,
          }
        : {
            is_safe: true,
            prompt: finalPrompt,
            description: characterDescription,
            title: characterTitle,
          };

    return {
      final_prompt: finalPrompt,
      safe_prompt: finalPrompt,
      text: finalPrompt,
      is_safe: true,
      json: jsonOutput,
      character_description: characterDescription,
      character_title: characterTitle,
      metadata: {
        model: res?.model || inputs.model || "gemini-3.1-flash-lite",
        skills,
        imagesCount: images.length,
        durationMs: res?.durationMs || 0,
      },
    };
  },
};

export default LlmNode;
