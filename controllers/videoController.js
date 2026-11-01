import { randomUUID } from "node:crypto";
import { generationRequestService } from "../src/container.js";
import { createLogger } from "../src/infrastructure/logging/index.js";
import { resolveMediaMetadata } from "../src/platform/media/mediaMetadataResolver.js";
import { assertOwns, assertOwnsAny, toMediaIdList } from "../src/platform/security/ownership.js";

const controllerLogger = createLogger("video-controller");

const MEDIA_PARAM_KEYS = [
  "input_image",
  "image_url",
  "mask",
  "last_frame",
  "input_video",
  "images",
  "reference_images",
  "reference_videos",
];

/**
 * POST /api/video/generated
 *
 * Pure HTTP Controller — Video Generation.
 *
 * Architecture:
 *   - Accepts model-specific params as an opaque `parameters` object.
 *   - Validates HTTP request shape, permissions, and media-specific constraints.
 *   - Delegates domain orchestration, placeholder persistence, and job dispatch to GenerationRequestService.
 */
export async function generateVideo(req, res) {
  try {
    const { prompt, model, references = [], parameters = {} } = req.body;
    const projectId = req.body.project_id || req.body.projectId || null;

    // ── Shape validation ─────────────────────────────────────────────────────

    // Reject direct media source fields — use workflow IDs in parameters.input_image or parameters.input_video
    if (req.body.image_url || req.body.source || req.body.input_image || req.body.source_url || req.body.video_url || req.body.input_video) {
      return res.status(400).json({
        ok: false,
        message: "Direct media sources are not permitted. Upload the asset via /api/assets/upload and pass the returned workflow_id in parameters.",
      });
    }

    if (!prompt?.trim()) {
      return res.status(400).json({ ok: false, message: "prompt is required" });
    }
    if (!projectId) {
      return res.status(400).json({ ok: false, message: "project_id is required" });
    }

    const chosenModel = (model || req.body.model_name || "").trim();
    if (!chosenModel) {
      return res.status(400).json({ ok: false, message: "model is required" });
    }

    // references must be workflow IDs only — no raw URLs
    const sanitizedReferences = [];
    for (const id of toMediaIdList(references)) {
      if (id.startsWith("http://") || id.startsWith("https://")) {
        return res.status(400).json({
          ok: false,
          message: "Direct URLs are not permitted in references. Use workflow IDs only.",
        });
      }
      sanitizedReferences.push(id);
    }

    // parameters values must also be workflow IDs — not raw URLs
    if (parameters && typeof parameters === "object") {
      for (const [key, val] of Object.entries(parameters)) {
        if (typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"))) {
          return res.status(400).json({
            ok: false,
            message: `Parameter "${key}": direct URLs are not permitted. Use a workflow ID instead.`,
          });
        }
      }
    }

    const userId = req.user.id;

    // ── 0. Enforce Project Ownership ─────────────────────────────────────────
    await assertOwns("project", projectId, userId);

    // ── 0b. Enforce Reference Ownership ──────────────────────────────────────
    for (const refId of sanitizedReferences) {
      await assertOwnsAny(["workflow", "character", "element", "media"], refId, userId);
    }

    // ── 0c. Enforce Input Media Ownership ────────────────────────────────────
    if (parameters && typeof parameters === "object") {
      for (const field of MEDIA_PARAM_KEYS) {
        for (const mediaRefId of toMediaIdList(parameters[field])) {
          if (!mediaRefId.startsWith("http")) {
            await assertOwnsAny(["workflow", "media"], mediaRefId, userId);
          }
        }
      }
    }

    // ── Media-specific metadata resolution (default 16:9 for video) ──────────
    const mediaMeta = resolveMediaMetadata({ parameters, ...req.body }, "16:9");
    const outputCount = 1;
    const rawFolderId = req.body.folder_id || req.body.folderId || req.body.collection_id || req.body.collectionId || null;

    // ── Delegate execution to GenerationRequestService ───────────────────────
    const result = await generationRequestService.requestGeneration({
      userId,
      mediaType: "video",
      stepId: "video_generation",
      useCaseId: "video-generation-v1",
      prompt,
      model: chosenModel,
      projectId,
      folderId: rawFolderId,
      references: sanitizedReferences,
      parameters,
      mediaMeta,
      outputCount,
      defaultMessages: {
        started: "Video generation started.",
        addCredits: "Add credits to generate your video.",
      },
    });

    return res.json(result);

  } catch (err) {
    if (err.code === "QUEUE_DISPATCH_FAILED") {
      return res.status(503).json({
        ok:         false,
        status:     "failed",
        code:       "QUEUE_DISPATCH_FAILED",
        message:    err.message,
        workflowId: err.workflowId,
        mediaId:    err.mediaId,
        mediaIds:   err.mediaIds,
      });
    }

    const statusCode = err.statusCode || 500;
    controllerLogger.error({ err, statusCode }, `generateVideo error: ${err.message}`);
    const traceId = err.workflowId || randomUUID();
    return res.status(statusCode).json({
      ok: false,
      code: statusCode >= 500 ? "INTERNAL_ERROR" : (err.code || "REQUEST_FAILED"),
      message: err.isOperational ? err.message : "Failed to generate video",
      traceId,
    });
  }
}
