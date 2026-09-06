import { run } from "../../models/index.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Executes image generation node via the Model-First Models Management System.
 *
 * @param {object} inputs - { prompt, width, height, count, seed, style, model, quality, image_url }
 * @param {object} ctx    - { runId, nodeId, userId, traceId, gateways }
 */
export async function executeImageGeneration(inputs, ctx) {
  const { runId, nodeId, userId } = ctx;

  // ── Safety: validate & sanitise all inputs before any model work ────────
  const safe = NodeSafetyService.assertImageInputs(inputs, nodeId);
  const started = Date.now();

  const modelFamily = safe.model;
  if (!modelFamily) {
    throw new Error(`[Node:${nodeId}] Missing required "model" input`);
  }

  // ── Translate workflow inputs → canonical Models System inputs ─────────────
  // The Models Management System infers the operation internally from semantic
  // parameters: if input_image is present → edit; otherwise → text_to_image.
  const canonicalInput = buildCanonicalInput(safe);

  // ── Model-First Execution via Models Management System ─────────────────────
  // Caller supplies ONLY model, canonical input, and context.
  // Models Management resolves operation + configured provider implementation internally.
  const runResult = await run(modelFamily, canonicalInput, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
  });

  // ── Normalize outputs → V2 asset shape ──────────────────────────────────
  // External code consumes only canonical result.images — no raw provider fields.
  const imageUrl = runResult.images?.[0]?.url ?? "";

  const assets = [
    {
      id: `img-${Date.now()}`,
      type: "image",
      url: imageUrl,
      width: safe.width ?? null,
      height: safe.height ?? null,
      metadata: {
        model: modelFamily,
      },
    },
  ];

  const durationMs = Date.now() - started;

  return {
    assets,
    metadata: { model: modelFamily, latencyMs: durationMs },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Converts raw workflow node inputs into the canonical parameter vocabulary
 * expected by the Models Management System.
 *
 * Workflow field       → Canonical field
 * ───────────────────────────────────────────────────────────────────────────
 * ratio                → aspect_ratio   (direct rename)
 * width + height       → resolution     (derived tier: "1k" | "2k" | "4k")
 * quality              → quality        (pass-through, already canonical)
 * seed                 → seed           (pass-through)
 * prompt               → prompt         (pass-through, required)
 * image_url / image    → input_image    (signals edit operation to Models Mgmt)
 * ─── Stripped (not in any model's canonicalInputs): ────────────────────────
 * model, count, references, width, height, ratio, style
 */
function buildCanonicalInput(safe) {
  const canonical = {};

  // Required
  if (safe.prompt !== undefined) canonical.prompt = safe.prompt;

  // Optional canonical fields
  if (safe.negative_prompt !== undefined) canonical.negative_prompt = safe.negative_prompt;
  if (safe.seed !== undefined && safe.seed !== null) canonical.seed = safe.seed;

  // quality → already canonical (standard | hd)
  if (safe.quality !== undefined && safe.quality !== null) canonical.quality = safe.quality;

  // ratio → aspect_ratio
  if (safe.ratio !== undefined && safe.ratio !== null) {
    canonical.aspect_ratio = safe.ratio;
  } else if (safe.aspect_ratio !== undefined && safe.aspect_ratio !== null) {
    canonical.aspect_ratio = safe.aspect_ratio;
  }

  // width + height → resolution tier
  const resolution = deriveResolution(safe.width, safe.height);
  if (resolution) canonical.resolution = resolution;

  // image_url / image → input_image (presence signals "edit" operation internally)
  const imageSource = safe.image_url ?? safe.image ?? safe.input_image ?? null;
  if (imageSource) canonical.input_image = imageSource;

  return canonical;
}

/**
 * Derives a canonical resolution tier string from pixel dimensions.
 *
 * Tier boundaries (based on the longest dimension):
 *   ≥ 3840px → "4k"
 *   ≥ 1920px → "2k"
 *   else     → "1k"
 *
 * Returns null when no dimension is provided (model default applies).
 *
 * @param {number|null|undefined} width
 * @param {number|null|undefined} height
 * @returns {"1k"|"2k"|"4k"|null}
 */
function deriveResolution(width, height) {
  const maxDim = Math.max(Number(width) || 0, Number(height) || 0);
  if (maxDim <= 0) return null;
  if (maxDim >= 3840) return "4k";
  if (maxDim >= 1920) return "2k";
  return "1k";
}
