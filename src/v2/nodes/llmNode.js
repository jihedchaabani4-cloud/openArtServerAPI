/**
 * LLM Node (V2 Architecture Specification)
 * skill_aware: true | provider-backed: true | LLM calls: TRUE (1 LLM Call)
 *
 * Internal Pipeline:
 *   1. Safety & Bounds Check → NodeSafetyService.assertLLMInputs
 *   2. Skill Loader & Prompt Compositor → Load YAML instructions & inject context snapshot
 *   3. Provider Invocation → LLMService (Gemini primary → Groq fallback)
 *   4. Structured JSON Normalizer → Format output into uniform contract schema
 *
 * Output: { text: string, json: object, modelUsed: string }
 */

import { NodeSafetyService } from "./safety/NodeSafetyService.js";
import { loadSkills } from "../registry/skillLoader.js";
import { llmService } from "../../platform/ai/LLMService.js";

/**
 * Render template placeholder parameters like {{style}} or {{views}}.
 */
function renderTemplate(templateStr = "", params = {}) {
  let result = templateStr;
  for (const [key, value] of Object.entries(params)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    result = result.replace(regex, String(value));
  }
  return result;
}

/**
 * Cleans markdown code blocks and extracts JSON object.
 */
function parseJSONResponse(rawText) {
  if (!rawText) throw new Error("Empty LLM response text cannot be parsed as JSON.");

  let cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

/**
 * Ensures returned JSON conforms to the Structured Generation Payload contract.
 * Sets aliases so downstream bindings like ${llm_enrich.output.json.description} and
 * ${llm_enrich.output.json.prompt} work seamlessly.
 */
/**
 * Ensures returned JSON conforms to the Structured Generation Payload contract.
 * Sets aliases so downstream bindings like ${llm_enrich.output.json.description} and
 * ${llm_enrich.output.json.prompt} work seamlessly.
 */
function normalizeStructuredJSON(parsed, userPrompt = "", { isSafetyActive = false } = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (isSafetyActive) {
      const err = new Error("LLM output contract violation: Expected JSON object payload for safety evaluation.");
      err.code = "OUTPUT_CONTRACT_VIOLATION";
      err.category = "UPSTREAM_FAULT";
      err.is_safe = false;
      throw err;
    }
    return {
      is_safe: true,
      safety_reason: null,
      prompt: userPrompt || "",
      description: userPrompt || "",
      title: "",
      keywords: [],
      references: [],
      generationConfig: {}
    };
  }

  // Strict Schema Validation for Content Moderation
  if (isSafetyActive) {
    if (typeof parsed.is_safe !== "boolean") {
      const err = new Error("LLM output contract violation: Missing or invalid boolean 'is_safe' field in safety moderation response.");
      err.code = "OUTPUT_CONTRACT_VIOLATION";
      err.category = "UPSTREAM_FAULT";
      err.is_safe = false;
      throw err;
    }
  }

  const isSafe = parsed.is_safe !== false && parsed.safe !== false && parsed.safety !== false;
  const safetyReason = parsed.safety_reason || parsed.reason || (isSafe ? null : "Safety Violation: Prompt contains prohibited sexual or nudity content.");

  const promptText = typeof parsed.description === "string" && parsed.description.trim()
    ? parsed.description.trim()
    : (typeof parsed.prompt === "string" && parsed.prompt.trim()
        ? parsed.prompt.trim()
        : (isSafetyActive ? "" : (userPrompt || "")));

  if (isSafetyActive && isSafe && !promptText) {
    const err = new Error("LLM output contract violation: Safe prompt returned empty description/prompt text.");
    err.code = "OUTPUT_CONTRACT_VIOLATION";
    err.category = "UPSTREAM_FAULT";
    err.is_safe = false;
    throw err;
  }

  return {
    ...parsed,
    is_safe: isSafe,
    safety_reason: safetyReason,
    prompt: promptText,
    description: promptText,
    title: parsed.title ?? "",
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    references: Array.isArray(parsed.references) ? parsed.references : [],
    generationConfig: parsed.generationConfig && typeof parsed.generationConfig === "object"
      ? parsed.generationConfig
      : {}
  };
}

/**
 * Executes the LLM Node.
 *
 * @param {object} resolvedInputs
 * @param {object} ctx - { runId, nodeId, userId, traceId, gateways, deps }
 * @returns {Promise<{ text: string, json: object, is_safe: boolean, safety_reason: string|null, modelUsed: string }>}
 */
export async function executeLLMNode(resolvedInputs, ctx = {}) {
  const { nodeId = "llm", runId = "run-1" } = ctx;
  const effectiveUserId = ctx.userId || resolvedInputs.userId || null;

  // ── 1. Safety & Boundary Check ─────────────────────────────────────────────
  const safe = NodeSafetyService.assertLLMInputs(resolvedInputs, nodeId);
  const {
    userPrompt,
    skills: skillIds = [],
    jsonMode = false,
    parameters = {},
    systemPromptOverride = null,
    images = [],
    context = null,
    model = undefined,
  } = safe;

  const isSafetyActive = skillIds.includes("llm/system-safety");

  // ── 2. Skill Loader & System Prompt Composition ───────────────────────────
  let systemPrompt = "";
  let skillsUsed = [];

  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride;
    skillsUsed = ["custom-override"];
  } else {
    const rawInstructionBlock = await loadSkills(skillIds);
    systemPrompt = renderTemplate(rawInstructionBlock, parameters);
    skillsUsed = [...skillIds];
  }

  // Attach Normalized Context Snapshot if provided
  if (context && typeof context === "object") {
    systemPrompt += `\n\n=== RESOLVED CONTEXT SNAPSHOT ===\n${JSON.stringify(context, null, 2)}`;
  }

  // Enforce Structured Output JSON format rule if jsonMode is active
  if (jsonMode) {
    systemPrompt += `\n\nOUTPUT CONTRACT: You MUST return ONLY a strictly valid JSON object matching this schema:\n{\n  "is_safe": true,\n  "safety_reason": null,\n  "title": "Short title",\n  "description": "Simple, faithful translated prompt text without added embellishments",\n  "keywords": ["tag1", "tag2"],\n  "references": [\n    { "assetId": "id", "role": "character_reference | style_reference | product_reference" }\n  ],\n  "generationConfig": {\n    "aspectRatio": "16:9"\n  }\n}`;
  }

  // ── 3. LLM Call & 1-Retry Fallback ─────────────────────────────────────────
  let result;
  try {
    result = await llmService.generate({
      prompt: userPrompt,
      systemInstruction: systemPrompt,
      images,
      jsonMode,
      userId: effectiveUserId,
      options: effectiveUserId ? {} : { isInternal: true, reason: "internal-platform-llm" },
      ...(model ? { model } : {}),
    });
  } catch (llmErr) {
    const isPolicyViolation =
      llmErr.code === "CONTENT_SAFETY_VIOLATION" ||
      llmErr.code === "PROVIDER_CONTENT_POLICY_ERROR" ||
      /safety|nsfw|sexual|explicit|prohibited content/i.test(llmErr.message || "");

    if (isPolicyViolation) {
      console.warn(`🛑 [LLMNode] Content safety policy violation: ${llmErr.message}`);
      const safetyErr = new Error(llmErr.message || "Safety Violation: Prompt contains prohibited content.");
      safetyErr.code = "CONTENT_SAFETY_VIOLATION";
      safetyErr.category = "USER_FAULT";
      safetyErr.statusCode = 422;
      safetyErr.is_safe = false;
      throw safetyErr;
    }

    // FAIL-CLOSED: LLM execution failures must never fall back to unmoderated raw prompts
    console.error(`❌ [LLMNode] LLM call failed (${llmErr.message}). Failing closed.`);
    const failErr = new Error(`Content safety verification failed: ${llmErr.message}`);
    failErr.code = llmErr.code && llmErr.code !== "Error" ? llmErr.code : "SAFETY_CHECK_FAILED";
    failErr.category = "UPSTREAM_FAULT";
    failErr.is_safe = false;
    failErr.cause = llmErr;
    throw failErr;
  }

  let jsonOutput = null;

  if (jsonMode) {
    try {
      const rawJson = result.json ?? parseJSONResponse(result.raw);
      jsonOutput = normalizeStructuredJSON(rawJson, userPrompt, { isSafetyActive });
    } catch (firstErr) {
      console.warn(`[LLMNode] Malformed JSON response from ${result.model}: ${firstErr.message}. Executing 1 retry with reinforced instructions...`);

      const reinforcedInstruction = `${systemPrompt}\n\nCRITICAL ERROR REINFORCEMENT: Your previous output failed JSON parsing. You MUST output ONLY valid JSON without markdown formatting or introductory text.`;

      let retryResult;
      try {
        retryResult = await llmService.generate({
          prompt: userPrompt,
          systemInstruction: reinforcedInstruction,
          images,
          jsonMode: true,
          userId: effectiveUserId,
          options: effectiveUserId ? {} : { isInternal: true, reason: "internal-platform-llm" },
        });
      } catch (retryLlmErr) {
        console.error(`❌ [LLMNode] LLM retry call failed (${retryLlmErr.message}). Failing closed.`);
        const retryFailErr = new Error(`Content safety verification failed: ${retryLlmErr.message}`);
        retryFailErr.code = "SAFETY_CHECK_FAILED";
        retryFailErr.category = "UPSTREAM_FAULT";
        retryFailErr.is_safe = false;
        retryFailErr.cause = retryLlmErr;
        throw retryFailErr;
      }

      try {
        const rawJson = retryResult.json ?? parseJSONResponse(retryResult.raw);
        jsonOutput = normalizeStructuredJSON(rawJson, userPrompt, { isSafetyActive });
      } catch (retryErr) {
        console.error(`❌ [LLMNode] Retry failed to parse structured JSON: ${retryErr.message}. Failing closed.`);
        const schemaErr = new Error(`LLM output contract violation: Free text or malformed JSON received when structured safety output was required.`);
        schemaErr.code = isSafetyActive ? "SAFETY_CHECK_FAILED" : "OUTPUT_CONTRACT_VIOLATION";
        schemaErr.category = "UPSTREAM_FAULT";
        schemaErr.is_safe = false;
        schemaErr.cause = retryErr;
        throw schemaErr;
      }
    }
  }

  // ── 4. Content Safety Enforcement ──────────────────────────────────────────
  // If the LLM detected safety violation, halt execution and flag error immediately
  if (jsonOutput && jsonOutput.is_safe === false) {
    const errorMsg = jsonOutput.safety_reason || "Safety Violation: Prompt contains prohibited content.";
    console.warn(`🛑 [LLMNode] Content safety violation: ${errorMsg}`);
    const safetyErr = new Error(errorMsg);
    safetyErr.code = "CONTENT_SAFETY_VIOLATION";
    safetyErr.category = "USER_FAULT";
    safetyErr.statusCode = 422;
    safetyErr.is_safe = false;
    throw safetyErr;
  }

  return {
    text: jsonOutput?.description ?? jsonOutput?.prompt ?? result.raw,
    json: jsonOutput,
    is_safe: jsonOutput?.is_safe ?? true,
    safety_reason: jsonOutput?.safety_reason ?? null,
    modelUsed: result.model,
  };
}

export { executeLLMNode as executeLLM };
export default executeLLMNode;
