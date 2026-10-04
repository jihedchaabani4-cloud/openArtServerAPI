import { run } from "../../models/index.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";
import { resolvePrimaryMediaUrl } from "../resolvers/WorkflowReferenceResolver.js";

/**
 * Image Generation Node — Pure Pass-Through
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Architecture contract:
 *   - Model Management is the ONLY source of truth for parameter definitions,
 *     allowed values, validation, provider mapping, and execution.
 *   - This node does NOT know model-specific fields (quality, resolution,
 *     aspect_ratio, prompt_optimization_mode, etc.).
 *   - It receives { model, prompt, parameters } and passes them directly to
 *     models.run(). Nothing more.
 *
 * The only responsibility of this node:
 *   1. Validate prompt (non-empty string).
 *   2. Resolve parameters.input_image workflow ID → URL if present.
 *   3. Call models.run(model, { prompt, ...parameters }).
 *   4. Normalize result to V2 asset shape.
 *
 * @param {object} inputs - { model, prompt, parameters }
 * @param {object} ctx    - { runId, nodeId, userId }
 */
export async function executeImageGeneration(inputs, ctx) {
  const { runId, nodeId, userId } = ctx;

  // ── 1. Validate prompt only — Model Management validates everything else ────
  NodeSafetyService.assertImageInputs(inputs, nodeId);
  const started = Date.now();

  const modelFamily = inputs.model;
  if (!modelFamily) {
    throw new Error(`[Node:${nodeId}] Missing required "model" input`);
  }

  const prompt = (inputs.prompt || "").trim();
  if (!prompt) {
    throw new Error(`[Node:${nodeId}] Missing required "prompt" input`);
  }

  // ── 2. Resolve input_image: workflow/media ID → URL ───────────────────────
  // The frontend sends a workflow ID for input_image (not a raw URL).
  // Resolve it to the actual CDN URL before passing to the model.
  const rawParams = (inputs.parameters && typeof inputs.parameters === "object")
    ? inputs.parameters
    : {};
  let resolvedParams = { ...rawParams };

  if (
    resolvedParams.input_image &&
    typeof resolvedParams.input_image === "string" &&
    !resolvedParams.input_image.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.input_image, userId);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve input_image "${resolvedParams.input_image}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.input_image = resolvedUrl;
  }

  if (Array.isArray(resolvedParams.images)) {
    resolvedParams.images = await Promise.all(
      resolvedParams.images.map(async (item) => {
        const idOrUrl = typeof item === "string" ? item : (item?.workflow_id || item?.id || item?.url);
        if (typeof idOrUrl === "string" && !idOrUrl.startsWith("http")) {
          const resolved = await resolvePrimaryMediaUrl(idOrUrl, userId);
          return resolved || idOrUrl;
        }
        return idOrUrl;
      })
    );
  }

  // ── 3. Build canonical input: prompt + model params (pass-through) ─────────
  // Model Management validates canonicalInput against the model's canonicalInputs,
  // rejects unknown params, maps to provider fields, and executes.
  const canonicalInput = { prompt, ...resolvedParams };

  // ── 4. Execute via Models Management System ───────────────────────────────
  const runResult = await run(modelFamily, canonicalInput, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
  });

  // ── 5. Normalize outputs → V2 image asset shape ───────────────────────────
  const rawImages = Array.isArray(runResult.images) ? runResult.images
    : Array.isArray(runResult.data?.images) ? runResult.data.images
    : (runResult.images ? [runResult.images]
    : (runResult.url ? [runResult.url]
    : (runResult.imageUrl ? [runResult.imageUrl]
    : [])));

  const assets = rawImages.map((img, idx) => ({
    id:       `img-${Date.now()}-${idx}`,
    type:     "image",
    url:      typeof img === "string" ? img : (img?.url || ""),
    metadata: { model: modelFamily, ...(typeof img === "object" ? img : {}) },
  }));

  return {
    assets,
    metadata: { model: modelFamily, latencyMs: Date.now() - started },
  };
}
