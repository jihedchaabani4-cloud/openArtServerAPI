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
    if (inputs.seed !== undefined && inputs.seed !== null) {
      safe.seed = Math.abs(Math.floor(Number(inputs.seed))) || null;
    }
    if (inputs.references !== undefined && inputs.references !== null) {
      safe.references = Array.isArray(inputs.references) ? inputs.references : [];
    }

    return safe;
  },

  // ── 2. Video Generation ─────────────────────────────────────────────────

  assertVideoInputs(inputs = {}, nodeId = "video-generation") {
    assertString(nodeId, "prompt", inputs.prompt, VIDEO_PROMPT_MAX);

    const safe = {
      ...inputs,
      prompt: inputs.prompt.trim(),
    };

    if (inputs.mode !== undefined && inputs.mode !== null) {
      if (!VIDEO_ALLOWED_MODES.includes(inputs.mode)) {
        fail(nodeId, "mode", `must be one of: ${VIDEO_ALLOWED_MODES.join(", ")} (got "${inputs.mode}").`);
      }
      safe.mode = inputs.mode;
      if (inputs.mode === "i2v") {
        assertUrl(nodeId, "startFrame", inputs.startFrame);
      }
    }

    if (inputs.aspect_ratio !== undefined && inputs.aspect_ratio !== null) {
      if (!VIDEO_ALLOWED_RATIOS.includes(inputs.aspect_ratio)) {
        fail(
          nodeId,
          "aspect_ratio",
          `must be one of: ${VIDEO_ALLOWED_RATIOS.join(", ")} (got "${inputs.aspect_ratio}").`,
        );
      }
      safe.aspect_ratio = inputs.aspect_ratio;
    }

    if (inputs.duration !== undefined && inputs.duration !== null) {
      safe.duration = clamp(inputs.duration, VIDEO_DURATION_MIN, VIDEO_DURATION_MAX);
    }
    if (inputs.fps !== undefined && inputs.fps !== null) {
      safe.fps = clamp(inputs.fps, VIDEO_FPS_MIN, VIDEO_FPS_MAX);
    }
    if (inputs.motion_strength !== undefined && inputs.motion_strength !== null) {
      safe.motion_strength = clamp(inputs.motion_strength, 0, 1);
    }
    if (inputs.references !== undefined && inputs.references !== null) {
      safe.references = Array.isArray(inputs.references) ? inputs.references : [];
    }

    return safe;
  },

  // ── 3. Upscale ──────────────────────────────────────────────────────────

  assertUpscaleInputs(inputs = {}, nodeId = "upscale") {
    const asset = inputs.asset;
    if (!asset || typeof asset !== "object") {
      fail(nodeId, "asset", "must be a valid asset object.");
    }
    assertUrl(nodeId, "asset.url", asset.url);

    const safe = {
      ...inputs,
      asset,
    };

    if (inputs.factor !== undefined && inputs.factor !== null) {
      const rawFactor = Number(inputs.factor);
      if (UPSCALE_ALLOWED_FACTORS.includes(rawFactor)) {
        safe.factor = rawFactor;
      } else {
        safe.factor = UPSCALE_ALLOWED_FACTORS.find((f) => f >= rawFactor) ?? UPSCALE_ALLOWED_FACTORS.at(-1);
      }
    }

    return safe;
  },

  // ── 4. Media Transform ──────────────────────────────────────────────────

  assertTransformInputs(inputs = {}, nodeId = "media-transform") {
    const sourceAsset = inputs.source_asset;
    if (!sourceAsset || typeof sourceAsset !== "object") {
      fail(nodeId, "source_asset", "must be a valid asset object.");
    }
    assertUrl(nodeId, "source_asset.url", sourceAsset.url);

    assertString(nodeId, "prompt", inputs.prompt, 2000);

    const safe = {
      ...inputs,
      source_asset: sourceAsset,
      prompt: inputs.prompt.trim(),
    };

    if (inputs.mode !== undefined && inputs.mode !== null) {
      if (!TRANSFORM_ALLOWED_MODES.includes(inputs.mode)) {
        fail(
          nodeId,
          "mode",
          `must be one of: ${TRANSFORM_ALLOWED_MODES.join(", ")} (got "${inputs.mode}").`,
        );
      }
      safe.mode = inputs.mode;
    }

    if (inputs.strength !== undefined && inputs.strength !== null) {
      safe.strength = clamp(inputs.strength, TRANSFORM_STRENGTH_MIN, TRANSFORM_STRENGTH_MAX);
    }
    if (inputs.width !== undefined && inputs.width !== null) {
      safe.width = clamp(inputs.width, IMAGE_WIDTH_MIN, IMAGE_WIDTH_MAX);
    }
    if (inputs.height !== undefined && inputs.height !== null) {
      safe.height = clamp(inputs.height, IMAGE_HEIGHT_MIN, IMAGE_HEIGHT_MAX);
    }
    if (inputs.references !== undefined && inputs.references !== null) {
      safe.references = Array.isArray(inputs.references) ? inputs.references : [];
    }

    return safe;
  },

  // ── 5. LLM ──────────────────────────────────────────────────────────────

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

  // ── 6. Prompt Builder ───────────────────────────────────────────────────

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

    const hasPrompt      = Boolean(promptText);
    const hasSourceAsset = inputs.source_asset && inputs.source_asset.url;
    const hasSkill       = inputs.skill && inputs.skill.id;

    if (!hasPrompt && !hasSourceAsset) {
      fail(
        nodeId,
        "prompt / source_asset",
        "at least one of prompt or source_asset.url must be provided.",
      );
    }

    if (inputs.skill !== null && inputs.skill !== undefined) {
      if (!hasSkill) {
        fail(nodeId, "skill.id", "skill object must contain a non-empty id string.");
      }
    }

    return {
      ...inputs,
      prompt:       promptText,
      references:   Array.isArray(inputs.references)
        ? inputs.references.filter(r => r !== null && r !== undefined && r !== "")
        : [],
      characters:   inputs.characters  ?? [],
      style:        inputs.style       ?? null,
      source_asset: inputs.source_asset ?? null,
      skill:        inputs.skill        ?? null,
      parameters:   inputs.parameters   ?? {},
    };
  },
};

export default NodeSafetyService;
