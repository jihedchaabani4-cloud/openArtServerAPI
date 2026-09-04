/**
 * NodeSafetyService
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised input validation & sanitisation layer for all V2 generation
 * nodes.  Every node calls its dedicated assertXxx() at the very start of
 * execution, before any provider or billing work begins.
 *
 * Design principles:
 *   1. Fail-fast  — throw on the first bad input, with a crystal-clear message.
 *   2. Strict     — do NOT inject silent hardcoded defaults; preserve caller values.
 *   3. Stateless  — pure functions, no DB / network calls.
 *   4. Internal   — used only by nodes in src/v2/nodes/.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const IMAGE_WIDTH_MIN   = 256;
const IMAGE_WIDTH_MAX   = 2048;
const IMAGE_HEIGHT_MIN  = 256;
const IMAGE_HEIGHT_MAX  = 2048;
const IMAGE_COUNT_MAX   = 8;
const IMAGE_PROMPT_MAX  = 2000;

const LLM_PROMPT_MAX      = 4000;
const LLM_TEMPERATURE_MIN = 0.0;
const LLM_TEMPERATURE_MAX = 2.0;


// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max);
}

function fail(nodeId, field, message) {
  const err = new Error(`[Node:${nodeId}] "${field}": ${message}`);
  err.code = "NODE_VALIDATION_ERROR";
  err.statusCode = 400;
  err.field = field;
  throw err;
}

function assertString(nodeId, field, value, maxLength = Infinity) {
  if (value === null || value === undefined || typeof value !== "string") {
    fail(nodeId, field, "must be a non-empty string.");
  }
  if (!value.trim()) {
    fail(nodeId, field, "cannot be empty or whitespace-only.");
  }
  if (value.length > maxLength) {
    fail(nodeId, field, `exceeds maximum length of ${maxLength} characters (got ${value.length}).`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const NodeSafetyService = {

  // ── 1. Image Generation ─────────────────────────────────────────────────

  assertImageInputs(inputs = {}, nodeId = "image-generation") {
    assertString(nodeId, "prompt", inputs.prompt, IMAGE_PROMPT_MAX);

    const safe = {
      ...inputs,
      prompt: inputs.prompt.trim(),
    };

    if (inputs.width !== undefined && inputs.width !== null) {
      safe.width = clamp(inputs.width, IMAGE_WIDTH_MIN, IMAGE_WIDTH_MAX);
    }
    if (inputs.height !== undefined && inputs.height !== null) {
      safe.height = clamp(inputs.height, IMAGE_HEIGHT_MIN, IMAGE_HEIGHT_MAX);
    }
    if (inputs.count !== undefined && inputs.count !== null) {
      const rawCount = Number(inputs.count);
      safe.count = isNaN(rawCount) ? 1 : clamp(rawCount, 1, IMAGE_COUNT_MAX);
    }
    if (inputs.references !== undefined && inputs.references !== null) {
      safe.references = Array.isArray(inputs.references) ? inputs.references : [];
    }

    return safe;
  },

  // ── 2. LLM ──────────────────────────────────────────────────────────────

  assertLLMInputs(inputs = {}, nodeId = "llm") {
    assertString(nodeId, "userPrompt", inputs.userPrompt, LLM_PROMPT_MAX);

    const hasSkills   = Array.isArray(inputs.skills) && inputs.skills.length > 0;
    const hasOverride = typeof inputs.systemPromptOverride === "string" && inputs.systemPromptOverride.trim();
    if (!hasSkills && !hasOverride) {
      fail(nodeId, "skills", "must be a non-empty array, or systemPromptOverride must be provided.");
    }

    const jsonMode = inputs.jsonMode === true || inputs.jsonMode === "true";

    let temperature = inputs.temperature ?? null;
    if (temperature !== null) {
      temperature = clamp(temperature, LLM_TEMPERATURE_MIN, LLM_TEMPERATURE_MAX);
    }

    const extractedImages = Array.isArray(inputs.images)
      ? inputs.images.map(img => (typeof img === "string" ? img : (img?.url || img?.src || ""))).filter(Boolean)
      : [];

    return {
      ...inputs,
      userPrompt: inputs.userPrompt.trim(),
      jsonMode,
      temperature,
      skills:               inputs.skills               ?? [],
      images:               extractedImages,
      parameters:           inputs.parameters           ?? {},
      systemPromptOverride: inputs.systemPromptOverride ?? null,
    };
  },

  // ── 3. Prompt Builder ───────────────────────────────────────────────────

  assertPromptBuilderInputs(inputs = {}, nodeId = "prompt-builder") {
    let promptText = "";
    if (typeof inputs.prompt === "string") {
      promptText = inputs.prompt.trim();
    } else if (inputs.prompt && typeof inputs.prompt === "object") {
      promptText = (inputs.prompt.description || inputs.prompt.prompt || inputs.prompt.text || "").trim();
    }

    if (!promptText && Array.isArray(inputs.characters) && inputs.characters.length > 0) {
      const firstChar = inputs.characters[0];
      promptText = (firstChar.description || firstChar.name || "").trim();
    }

    if (!promptText) {
      fail(nodeId, "prompt", "prompt must be provided.");
    }

    if (inputs.skill !== null && inputs.skill !== undefined) {
      if (!inputs.skill?.id) {
        fail(nodeId, "skill.id", "skill object must contain a non-empty id string.");
      }
    }

    return {
      ...inputs,
      prompt:     promptText,
      references: Array.isArray(inputs.references)
        ? inputs.references.filter(r => r !== null && r !== undefined && r !== "")
        : [],
      characters: inputs.characters ?? [],
      style:      inputs.style      ?? null,
      skill:      inputs.skill      ?? null,
      parameters: inputs.parameters ?? {},
    };
  },

};

export default NodeSafetyService;
