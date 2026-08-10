/**
 * NodeSafetyService
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised input validation & sanitisation layer for all V2 generation
 * nodes.  Every node calls its dedicated assertXxx() at the very start of
 * execution, before any provider or billing work begins.
 *
 * Design principles
 *   1. Fail-fast  — throw on the first bad input, with a crystal-clear message.
 *   2. Sanitise   — clamp / coerce / default so the provider always gets safe values.
 *   3. Stateless  — pure functions, no DB / network calls.
 *   4. Internal   — used only by nodes in src/v2/nodes/.
 *
 * All methods return the sanitised input object so nodes can destructure it
 * immediately:
 *   const safe = NodeSafetyService.assertImageInputs(inputs, nodeId);
 */

// ── Constants ────────────────────────────────────────────────────────────────

const IMAGE_WIDTH_MIN   = 256;
const IMAGE_WIDTH_MAX   = 2048;
const IMAGE_HEIGHT_MIN  = 256;
const IMAGE_HEIGHT_MAX  = 2048;
const IMAGE_COUNT_MAX   = 8;
const IMAGE_PROMPT_MAX  = 2000;

const VIDEO_DURATION_MIN  = 3;
const VIDEO_DURATION_MAX  = 60;
const VIDEO_FPS_MIN       = 8;
const VIDEO_FPS_MAX       = 60;
const VIDEO_ALLOWED_MODES = ["t2v", "i2v"];
const VIDEO_ALLOWED_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const VIDEO_PROMPT_MAX    = 2000;

const UPSCALE_ALLOWED_FACTORS = [1, 2, 4];

const TRANSFORM_ALLOWED_MODES = [
  "image_edit",
  "image_to_image",
  "image_variation",
  "video_to_video",
];
const TRANSFORM_STRENGTH_MIN = 0.0;
const TRANSFORM_STRENGTH_MAX = 1.0;

const LLM_PROMPT_MAX      = 4000;
const LLM_TEMPERATURE_MIN = 0.0;
const LLM_TEMPERATURE_MAX = 2.0;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Clamp a number between min and max (inclusive).
 */
function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max);
}

/**
 * Throw a NodeValidationError with a consistent format.
 * @param {string} nodeId
 * @param {string} field
 * @param {string} message
 */
function fail(nodeId, field, message) {
  const err = new Error(`[Node:${nodeId}] "${field}": ${message}`);
  err.code = "NODE_VALIDATION_ERROR";
  err.statusCode = 400;
  err.field = field;
  throw err;
}

/**
 * Assert a string is non-null, non-empty, and within a max length.
 */
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

/**
 * Assert a value is a valid URL string.
 */
function assertUrl(nodeId, field, value) {
  if (!value || typeof value !== "string" || !value.trim()) {
    fail(nodeId, field, "must be a non-empty URL string.");
  }
  try {
    new URL(value);
  } catch {
    fail(nodeId, field, `"${value}" is not a valid URL.`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export const NodeSafetyService = {

  // ── 1. Image Generation ─────────────────────────────────────────────────

  /**
   * Validates and sanitises inputs for imageGenerationNode.
   * @param {object} inputs
   * @param {string} nodeId
   * @returns {object} sanitised inputs ready for the provider
   */
  assertImageInputs(inputs = {}, nodeId = "image-generation") {
    // Required
    assertString(nodeId, "prompt", inputs.prompt, IMAGE_PROMPT_MAX);

    // Sanitise dimensions (clamp into safe range)
    const width  = clamp(inputs.width  ?? 1024, IMAGE_WIDTH_MIN,  IMAGE_WIDTH_MAX);
    const height = clamp(inputs.height ?? 1024, IMAGE_HEIGHT_MIN, IMAGE_HEIGHT_MAX);

    // Sanitise count (min 1, max 8)
    const rawCount = Number(inputs.count ?? 1);
    const count = isNaN(rawCount) ? 1 : clamp(rawCount, 1, IMAGE_COUNT_MAX);

    // Sanitise seed (must be a positive integer or null)
    let seed = inputs.seed ?? null;
    if (seed !== null) {
      seed = Math.abs(Math.floor(Number(seed))) || null;
    }

    return {
      ...inputs,
      prompt: inputs.prompt.trim(),
      width,
      height,
      count,
      seed,
      quality:    inputs.quality    ?? "standard",
      style:      inputs.style      ?? null,
      references: inputs.references ?? [],
      model:      inputs.model      ?? null,
    };
  },

  // ── 2. Video Generation ─────────────────────────────────────────────────

  /**
   * Validates and sanitises inputs for videoGenerationNode.
   * @param {object} inputs
   * @param {string} nodeId
   * @returns {object} sanitised inputs ready for the provider
   */
  assertVideoInputs(inputs = {}, nodeId = "video-generation") {
    // Required: prompt
    assertString(nodeId, "prompt", inputs.prompt, VIDEO_PROMPT_MAX);

    // mode enum
    const mode = inputs.mode ?? "t2v";
    if (!VIDEO_ALLOWED_MODES.includes(mode)) {
      fail(nodeId, "mode", `must be one of: ${VIDEO_ALLOWED_MODES.join(", ")} (got "${mode}").`);
    }

    // Image-to-video: startFrame is required
    if (mode === "i2v") {
      assertUrl(nodeId, "startFrame", inputs.startFrame);
    }

    // aspect_ratio enum
    const aspect_ratio = inputs.aspect_ratio ?? "16:9";
    if (!VIDEO_ALLOWED_RATIOS.includes(aspect_ratio)) {
      fail(
        nodeId,
        "aspect_ratio",
        `must be one of: ${VIDEO_ALLOWED_RATIOS.join(", ")} (got "${aspect_ratio}").`,
      );
    }

    // Sanitise duration (clamp 3–60 s)
    const duration = clamp(inputs.duration ?? 5, VIDEO_DURATION_MIN, VIDEO_DURATION_MAX);

    // Sanitise fps (clamp 8–60)
    const fps = clamp(inputs.fps ?? 24, VIDEO_FPS_MIN, VIDEO_FPS_MAX);

    // motion_strength (optional, clamp 0–1 if provided)
    let motion_strength = inputs.motion_strength ?? null;
    if (motion_strength !== null) {
      motion_strength = clamp(motion_strength, 0, 1);
    }

    return {
      ...inputs,
      prompt: inputs.prompt.trim(),
      mode,
      aspect_ratio,
      duration,
      fps,
      motion_strength,
      startFrame:  inputs.startFrame  ?? null,
      references:  inputs.references  ?? [],
      model:       inputs.model       ?? null,
    };
  },

  // ── 3. Upscale ──────────────────────────────────────────────────────────

  /**
   * Validates and sanitises inputs for upscaleNode.
   * @param {object} inputs
   * @param {string} nodeId
   * @returns {object} sanitised inputs ready for the provider
   */
  assertUpscaleInputs(inputs = {}, nodeId = "upscale") {
    // asset.url required
    const asset = inputs.asset;
    if (!asset || typeof asset !== "object") {
      fail(nodeId, "asset", "must be a valid asset object.");
    }
    assertUrl(nodeId, "asset.url", asset.url);

    // factor must be 1, 2, or 4
    const rawFactor = Number(inputs.factor ?? 2);
    let factor = 2;
    if (UPSCALE_ALLOWED_FACTORS.includes(rawFactor)) {
      factor = rawFactor;
    } else {
      // Snap up to the next allowed factor (safer: never produce less than requested)
      factor = UPSCALE_ALLOWED_FACTORS.find((f) => f >= rawFactor) ?? UPSCALE_ALLOWED_FACTORS.at(-1);
    }

    return {
      ...inputs,
      asset,
      factor,
      quality: inputs.quality ?? "standard",
    };
  },

  // ── 4. Media Transform ──────────────────────────────────────────────────

  /**
   * Validates and sanitises inputs for mediaTransformNode.
   * @param {object} inputs
   * @param {string} nodeId
   * @returns {object} sanitised inputs ready for the provider
   */
  assertTransformInputs(inputs = {}, nodeId = "media-transform") {
    // source_asset.url required
    const sourceAsset = inputs.source_asset;
    if (!sourceAsset || typeof sourceAsset !== "object") {
      fail(nodeId, "source_asset", "must be a valid asset object.");
    }
    assertUrl(nodeId, "source_asset.url", sourceAsset.url);

    // mode enum
    const mode = inputs.mode ?? "image_edit";
    if (!TRANSFORM_ALLOWED_MODES.includes(mode)) {
      fail(
        nodeId,
        "mode",
        `must be one of: ${TRANSFORM_ALLOWED_MODES.join(", ")} (got "${mode}").`,
      );
    }

    // prompt required for all edit / transform modes
    assertString(nodeId, "prompt", inputs.prompt, 2000);

    // strength (clamp 0–1)
    const strength = clamp(inputs.strength ?? 0.75, TRANSFORM_STRENGTH_MIN, TRANSFORM_STRENGTH_MAX);

    // dimensions
    const width  = clamp(inputs.width  ?? sourceAsset.width  ?? 1024, IMAGE_WIDTH_MIN,  IMAGE_WIDTH_MAX);
    const height = clamp(inputs.height ?? sourceAsset.height ?? 1024, IMAGE_HEIGHT_MIN, IMAGE_HEIGHT_MAX);

    return {
      ...inputs,
      source_asset: sourceAsset,
      mode,
      prompt: inputs.prompt.trim(),
      strength,
      width,
      height,
      references: inputs.references ?? [],
      model:      inputs.model      ?? null,
    };
  },

  // ── 5. LLM ──────────────────────────────────────────────────────────────

  /**
   * Validates and sanitises inputs for llmNode.
   * @param {object} inputs
   * @param {string} nodeId
   * @returns {object} sanitised inputs ready for llmService
   */
  assertLLMInputs(inputs = {}, nodeId = "llm") {
    // userPrompt required
    assertString(nodeId, "userPrompt", inputs.userPrompt, LLM_PROMPT_MAX);

    // Must have skills OR systemPromptOverride
    const hasSkills   = Array.isArray(inputs.skills) && inputs.skills.length > 0;
    const hasOverride = typeof inputs.systemPromptOverride === "string" && inputs.systemPromptOverride.trim();
    if (!hasSkills && !hasOverride) {
      fail(nodeId, "skills", "must be a non-empty array, or systemPromptOverride must be provided.");
    }

    // jsonMode: coerce to boolean
    const jsonMode = inputs.jsonMode === true || inputs.jsonMode === "true";

    // temperature: clamp 0–2
    let temperature = inputs.temperature ?? null;
    if (temperature !== null) {
      temperature = clamp(temperature, LLM_TEMPERATURE_MIN, LLM_TEMPERATURE_MAX);
    }

    return {
      ...inputs,
      userPrompt: inputs.userPrompt.trim(),
      jsonMode,
      temperature,
      skills:               inputs.skills               ?? [],
      images:               Array.isArray(inputs.images) ? inputs.images : [],
      parameters:           inputs.parameters           ?? {},
      systemPromptOverride: inputs.systemPromptOverride ?? null,
    };
  },

  // ── 6. Prompt Builder ───────────────────────────────────────────────────

  /**
   * Validates and sanitises inputs for promptBuilderNode.
   * @param {object} inputs
   * @param {string} nodeId
   * @returns {object} sanitised inputs
   */
  assertPromptBuilderInputs(inputs = {}, nodeId = "prompt-builder") {
    const hasPrompt      = typeof inputs.prompt === "string" && inputs.prompt.trim();
    const hasSourceAsset = inputs.source_asset && inputs.source_asset.url;
    const hasSkill       = inputs.skill && inputs.skill.id;

    // At least a prompt or a source_asset is needed to build anything
    if (!hasPrompt && !hasSourceAsset) {
      fail(
        nodeId,
        "prompt / source_asset",
        "at least one of prompt or source_asset.url must be provided.",
      );
    }

    // Skill is optional, but if provided must have an id
    if (inputs.skill !== null && inputs.skill !== undefined) {
      if (!hasSkill) {
        fail(nodeId, "skill.id", "skill object must contain a non-empty id string.");
      }
    }

    return {
      ...inputs,
      prompt:      (inputs.prompt ?? "").trim(),
      references:  inputs.references  ?? [],
      characters:  inputs.characters  ?? [],
      style:       inputs.style       ?? null,
      source_asset: inputs.source_asset ?? null,
      skill:        inputs.skill        ?? null,
      parameters:   inputs.parameters   ?? {},
    };
  },
};

export default NodeSafetyService;
