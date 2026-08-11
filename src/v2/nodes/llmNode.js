/**
 * LLM Node (Infrastructure Node)
 * skill_aware: true | provider-backed: true (LLM API)
 *
 * Internal pipeline:
 *   1. Input Validation    → validate skills and userPrompt
 *   2. Skills Loading      → load prompt instructions via skillLoader.js
 *   3. Template Rendering  → replace {{param}} placeholders in system instructions
 *   4. System Prompt Assembly → merge prompt instructions into a unified system prompt
 *   5. Override Bypass     → if systemPromptOverride provided, use directly
 *   6. LLM Call            → invoke LLMService.generate with fallback & 1-retry for malformed JSON
 *   7. Response Validation → parse JSON if jsonMode=true (with clean code fences)
 *   8. Output Assembly     → return { text, json, usage, model, provider, skillsUsed }
 */

import llmService from "#platform/ai/LLMService.js";
import { loadSkills } from "../registry/skillLoader.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Renders template strings by replacing {{param}} placeholders with parameter values.
 * @param {string} template
 * @param {Record<string, unknown>} parameters
 * @returns {string}
 */
function renderTemplate(template, parameters = {}) {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = parameters[key];
    if (val === undefined || val === null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
}

/**
 * Cleans markdown code blocks and extracts JSON.
 * @param {string} rawText
 * @returns {object}
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
 * Executes the LLM Node.
 *
 * @param {object} resolvedInputs
 * @param {string[]} resolvedInputs.skills           - Skill IDs (e.g. ["llm/translation", "llm/json-output"])
 * @param {string}   resolvedInputs.userPrompt       - Main task/user prompt
 * @param {string[]} [resolvedInputs.images]         - Optional image URLs for Vision
 * @param {string}   [resolvedInputs.model]          - Model override option
 * @param {number}   [resolvedInputs.temperature]    - LLM temperature
 * @param {boolean}  [resolvedInputs.jsonMode]       - Parse JSON flag
 * @param {object}   [resolvedInputs.parameters]     - Template parameters for skills
 * @param {string}   [resolvedInputs.systemPromptOverride] - Skip skills assembly
 *
 * @param {object} ctx
 * @param {string} ctx.runId
 * @param {string} ctx.nodeId
 * @param {string} ctx.traceId
 *
 * @returns {Promise<{
 *   text: string,
 *   json: object|null,
 *   usage: object,
 *   model: string,
 *   provider: string,
 *   skillsUsed: string[]
 * }>}
 */
export async function executeLLM(resolvedInputs, ctx) {
  const { runId, nodeId, traceId } = ctx;
  const started = Date.now();

  // ── Safety: validate & sanitise all inputs before any LLM call ────────────
  const safe = NodeSafetyService.assertLLMInputs(resolvedInputs, nodeId);

  // Resolve skill IDs (support legacy single-skill object format)
  let skillIds = safe.skills.length > 0
    ? safe.skills
    : (resolvedInputs.skill?.id ? [resolvedInputs.skill.id] : []);

  const { userPrompt, images, jsonMode, parameters } = safe;

  logV2Event({
    traceId,
    operation: `node.llm:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `LLM Node starting — skills: [${skillIds.join(", ")}]`,
  });

  // ── Step 2: System Prompt Assembly ───────────────────────────────────────
  let systemPrompt = "";
  let skillsUsed = [];

  if (resolvedInputs.systemPromptOverride) {
    systemPrompt = resolvedInputs.systemPromptOverride;
    skillsUsed = [];
  } else {
    // Load skills prompt instructions via skillLoader
    const rawInstructionBlock = await loadSkills(skillIds);
    systemPrompt = renderTemplate(rawInstructionBlock, parameters);
    skillsUsed = [...skillIds];
  }

  // ── Step 3: Call LLMService (with 1-retry for malformed JSON) ──────────────
  let result = await llmService.generate({
    prompt: userPrompt,
    systemInstruction: systemPrompt,
    images,
    jsonMode,
  });

  let jsonOutput = null;
  if (jsonMode) {
    try {
      jsonOutput = result.json ?? parseJSONResponse(result.raw);
    } catch (firstErr) {
      console.warn(`[LLMNode] Malformed JSON on initial response from ${result.model}: ${firstErr.message}. Executing 1 retry with reinforced JSON rule...`);

      // Retry 1 (reinforced prompt instruction)
      const reinforcedInstruction = `${systemPrompt}\n\nCRITICAL REMINDER: Your previous output failed JSON validation. You MUST return ONLY a strictly valid JSON object. No prose, no markdown fences.`;

      result = await llmService.generate({
        prompt: userPrompt,
        systemInstruction: reinforcedInstruction,
        images,
        jsonMode: true,
      });

      try {
        jsonOutput = result.json ?? parseJSONResponse(result.raw);
      } catch (retryErr) {
        throw new Error(
          `LLM Node (${nodeId}): Failed to parse JSON response after retry. ` +
          `Raw output: "${(result.raw ?? "").slice(0, 200)}..." Error: ${retryErr.message}`
        );
      }
    }
  }

  const durationMs = Date.now() - started;
  logV2Event({
    traceId,
    operation: `node.llm:${nodeId}`,
    durationMs,
    status: "success",
    message: `LLM Node completed — model: ${result.model}, skills: [${skillsUsed.join(", ")}]`,
  });

  const providerName = result.model?.includes("gemini") ? "google" : "groq";

  return {
    text: result.raw ?? "",
    json: jsonOutput,
    usage: { model: result.model },
    model: result.model,
    provider: providerName,
    skillsUsed,
  };
}
