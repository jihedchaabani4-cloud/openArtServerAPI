/**
 * LLM Node (Infrastructure Node & Generic Intelligence Primitive)
 * skill_aware: true | provider-backed: true (LLM API)
 *
 * Internal Pipeline:
 *   1. Input Validation    → NodeSafetyService.assertLLMInputs
 *   2. Context & Skills    → Unpack normalized context from promptBuilderNode
 *   3. Template Rendering  → Combine Skill instructions + Resolved Context snapshot
 *   4. LLM Call            → Invoke LLMService.generate with fallback & 1-retry for malformed JSON
 *   5. Response Validation → Enforce Structured Output JSON schema ({ prompt, references, generationConfig })
 *   6. Output Assembly     → Return { text, json, usage, model, provider, skillsUsed }
 */

import llmService from "#platform/ai/LLMService.js";
import { loadSkills } from "../registry/skillLoader.js";
import { logV2Event } from "../logging/v2Logger.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Renders template strings by replacing {{param}} placeholders with parameter values.
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
 */
function normalizeStructuredJSON(parsed, userPrompt = "") {
  if (!parsed || typeof parsed !== "object") {
    return {
      prompt: userPrompt,
      references: [],
      generationConfig: { aspectRatio: "16:9" }
    };
  }

  return {
    prompt: typeof parsed.prompt === "string" ? parsed.prompt : (userPrompt || "High quality generation"),
    references: Array.isArray(parsed.references) ? parsed.references : [],
    generationConfig: parsed.generationConfig && typeof parsed.generationConfig === "object"
      ? parsed.generationConfig
      : { aspectRatio: "16:9" }
  };
}

/**
 * Executes the LLM Node.
 *
 * @param {object} resolvedInputs
 * @param {string}   resolvedInputs.userPrompt       - Main task/user prompt
 * @param {string[]} [resolvedInputs.skills]         - Skill IDs (e.g. ["cinematic-image-prompt"])
 * @param {object}   [resolvedInputs.context]        - Normalized Context Snapshot from promptBuilderNode
 * @param {string[]} [resolvedInputs.images]         - Optional image URLs for Multimodal Vision
 * @param {boolean}  [resolvedInputs.jsonMode]       - Enforce JSON output schema
 * @param {number}   [resolvedInputs.temperature]    - LLM temperature
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
export async function executeLLM(resolvedInputs, ctx = {}) {
  const { runId = "run-1", nodeId = "llm-node", traceId = "tr-1" } = ctx;
  const started = Date.now();

  // ── 1. Safety & Boundary Check ─────────────────────────────────────────────
  const safe = NodeSafetyService.assertLLMInputs(resolvedInputs, nodeId);

  let skillIds = safe.skills.length > 0
    ? safe.skills
    : (resolvedInputs.skill?.id ? [resolvedInputs.skill.id] : ["cinematic-image-prompt"]);

  const { userPrompt, context, images, jsonMode, parameters } = safe;

  logV2Event({
    traceId,
    operation: `node.llm:${nodeId}`,
    durationMs: 0,
    status: "success",
    message: `LLM Node starting — skills: [${skillIds.join(", ")}]`,
  });

  // ── 2. System Instruction Assembly ───────────────────────────────────────
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

  // Attach Normalized Context Snapshot if provided
  if (context && typeof context === "object") {
    systemPrompt += `\n\n=== RESOLVED CONTEXT SNAPSHOT ===\n${JSON.stringify(context, null, 2)}`;
  }

  // Enforce Structured Output JSON format rule if jsonMode is active
  if (jsonMode) {
    systemPrompt += `\n\nOUTPUT CONTRACT: You MUST return ONLY a strictly valid JSON object matching this schema:\n{\n  "prompt": "Enhanced cinematic prompt text",\n  "references": [\n    { "assetId": "id", "role": "character_reference | style_reference | product_reference" }\n  ],\n  "generationConfig": {\n    "aspectRatio": "16:9"\n  }\n}`;
  }

  // ── 3. LLM Call & 1-Retry Fallback ─────────────────────────────────────────
  let result = await llmService.generate({
    prompt: userPrompt,
    systemInstruction: systemPrompt,
    images,
    jsonMode,
  });

  let jsonOutput = null;

  if (jsonMode) {
    try {
      const rawJson = result.json ?? parseJSONResponse(result.raw);
      jsonOutput = normalizeStructuredJSON(rawJson, userPrompt);
    } catch (firstErr) {
      console.warn(`[LLMNode] Malformed JSON response from ${result.model}: ${firstErr.message}. Executing 1 retry with reinforced instructions...`);

      const reinforcedInstruction = `${systemPrompt}\n\nCRITICAL ERROR REINFORCEMENT: Your previous output failed JSON parsing. You MUST output ONLY valid JSON without markdown formatting or introductory text.`;

      result = await llmService.generate({
        prompt: userPrompt,
        systemInstruction: reinforcedInstruction,
        images,
        jsonMode: true,
      });

      try {
        const rawJson = result.json ?? parseJSONResponse(result.raw);
        jsonOutput = normalizeStructuredJSON(rawJson, userPrompt);
      } catch (retryErr) {
        console.warn(`[LLMNode] Retry failed to parse JSON. Falling back to default structured wrapper.`);
        jsonOutput = normalizeStructuredJSON(null, userPrompt);
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

export default executeLLM;
