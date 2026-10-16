import { run } from "../../models/index.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";
import { resolvePrimaryMediaUrl } from "../resolvers/WorkflowReferenceResolver.js";
import { toMediaIdList } from "../../platform/security/ownership.js";

/**
 * Video Generation Node — Pure Pass-Through
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Architecture contract:
 *   - Model Management is the ONLY source of truth for parameter definitions,
 *     allowed values, validation, provider mapping, and execution.
 *   - External caller supplies modelFamily + semantic parameters.
 *   - This node receives { model, prompt, parameters } and passes them directly to
 *     models.run().
 *
 * Responsibilities:
 *   1. Validate prompt (non-empty string).
 *   2. Resolve keyframes / video inputs (workflow ID → CDN URL):
 *      - parameters.input_image  (Start Frame)
 *      - parameters.last_frame   (End Frame)
 *      - parameters.input_video  (Source Video continuation)
 *      - parameters.images       (Multi-reference images)
 *   3. Call models.run(model, { prompt, ...parameters }).
 *   4. Normalize result to V2 video asset shape.
 *
 * @param {object} inputs - { model, prompt, parameters }
 * @param {object} ctx    - { runId, nodeId, userId }
 */
export async function executeVideoGeneration(inputs, ctx) {
  const { runId, nodeId, userId } = ctx;

  // ── 1. Validate prompt only — Model Management validates model parameters ────
  NodeSafetyService.assertVideoInputs(inputs, nodeId);
  const started = Date.now();

  const modelFamily = inputs.model;
  if (!modelFamily) {
    throw new Error(`[Node:${nodeId}] Missing required "model" input`);
  }

  const prompt = (inputs.prompt || "").trim();
  if (!prompt) {
    throw new Error(`[Node:${nodeId}] Missing required "prompt" input`);
  }

  // ── 2. Resolve workflow/media IDs → CDN URLs ──────────────────────────────
  const rawParams = (inputs.parameters && typeof inputs.parameters === "object")
    ? inputs.parameters
    : {};
  let resolvedParams = { ...rawParams };

  // 2a. Start frame (input_image)
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

  // 2b. End frame (last_frame)
  if (
    resolvedParams.last_frame &&
    typeof resolvedParams.last_frame === "string" &&
    !resolvedParams.last_frame.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.last_frame, userId);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve last_frame "${resolvedParams.last_frame}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.last_frame = resolvedUrl;
  }

  // 2c. Input video (input_video)
  if (
    resolvedParams.input_video &&
    typeof resolvedParams.input_video === "string" &&
    !resolvedParams.input_video.startsWith("http")
  ) {
    const resolvedUrl = await resolvePrimaryMediaUrl(resolvedParams.input_video, userId);
    if (!resolvedUrl) {
      throw new Error(
        `[Node:${nodeId}] Could not resolve input_video "${resolvedParams.input_video}" to a URL. ` +
        "Ensure the workflow ID exists and has a completed media record."
      );
    }
    resolvedParams.input_video = resolvedUrl;
  }

  // 2d. Multi-reference images (images)
  if (resolvedParams.images !== undefined && resolvedParams.images !== null) {
    const imageList = toMediaIdList(resolvedParams.images);
    resolvedParams.images = await Promise.all(
      imageList.map(async (idOrUrl) => {
        if (typeof idOrUrl === "string" && !idOrUrl.startsWith("http")) {
          const resolved = await resolvePrimaryMediaUrl(idOrUrl, userId);
          return resolved || idOrUrl;
        }
        return idOrUrl;
      })
    );
  }

  // ── 3. Build canonical input: prompt + model params (pass-through) ─────────
  const canonicalInput = { prompt, ...resolvedParams };

  // ── 4. Execute via Models Management System ───────────────────────────────
  const runResult = await run(modelFamily, canonicalInput, {
    idempotencyKey: `node:${runId}:${nodeId}`,
    userId,
  });

  // ── 5. Normalize outputs → V2 Video Asset Shape ───────────────────────────
  const rawVideos = Array.isArray(runResult.videos) ? runResult.videos
    : Array.isArray(runResult.data?.videos) ? runResult.data.videos
    : (runResult.videos ? [runResult.videos]
    : (runResult.url ? [runResult.url]
    : (runResult.videoUrl ? [runResult.videoUrl]
    : [])));

  const assets = rawVideos.map((vid, idx) => ({
    id:       `vid-${Date.now()}-${idx}`,
    type:     "video",
    url:      typeof vid === "string" ? vid : (vid?.url || ""),
    metadata: { model: modelFamily, ...(typeof vid === "object" ? vid : {}) },
  }));

  return {
    assets,
    metadata: {
      model: modelFamily,
      provider: runResult._internal?.provider || null,
      latencyMs: Date.now() - started,
    },
  };
}
