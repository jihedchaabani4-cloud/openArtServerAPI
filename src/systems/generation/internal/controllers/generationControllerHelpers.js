/**
 * Shared HTTP Controller Helpers — Image & Video Generation Endpoints
 *
 * Centralizes request shape/URL validation, resource ownership enforcement,
 * service delegation, and canonical HTTP error formatting for media generation
 * and image-edit controllers inside System 1 (`generation`).
 */

import { randomUUID } from "node:crypto";
import { getGenerationServices } from "../services/serviceAccessor.js";
import { resolveMediaMetadata } from "#media/tools";
import { assertOwns, assertOwnsAny, toMediaIdList } from "#identity/tools";

export const MEDIA_PARAM_KEYS = [
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
 * Formats and sends a canonical HTTP error response for generation & edit controllers.
 */
export function sendGenerationControllerError(res, err, { logger, actionName, fallbackMessage }) {
  if (err.code === "QUEUE_DISPATCH_FAILED") {
    return res.status(503).json({
      ok: false,
      status: "failed",
      code: "QUEUE_DISPATCH_FAILED",
      message: err.message,
      workflowId: err.workflowId,
      mediaId: err.mediaId,
      mediaIds: err.mediaIds,
    });
  }

  const statusCode = err.statusCode || 500;
  logger.error({ err, statusCode }, `${actionName} error: ${err.message}`);
  const traceId = err.workflowId || randomUUID();
  return res.status(statusCode).json({
    ok: false,
    code: statusCode >= 500 ? "INTERNAL_ERROR" : (err.code || "REQUEST_FAILED"),
    message: err.isOperational ? err.message : fallbackMessage,
    traceId,
  });
}

/**
 * Shared controller pipeline for `POST /api/images/generated` and `POST /api/video/generated`.
 */
export async function handleMediaGenerationRequest(
  req,
  res,
  {
    logger,
    actionName,
    mediaType,
    stepId,
    useCaseId,
    forbiddenSourceFields,
    directSourceMessage,
    referencesDirectUrlMessage,
    defaultAspectRatio = null,
    defaultMessages,
    fallbackErrorMessage,
  }
) {
  try {
    const { prompt, model, references = [], parameters = {} } = req.body;
    const projectId = req.body.project_id || req.body.projectId || null;

    if (forbiddenSourceFields.some((field) => Boolean(req.body[field]))) {
      return res.status(400).json({
        ok: false,
        message: directSourceMessage,
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

    const sanitizedReferences = [];
    for (const id of toMediaIdList(references)) {
      if (id.startsWith("http://") || id.startsWith("https://")) {
        return res.status(400).json({
          ok: false,
          message: referencesDirectUrlMessage,
        });
      }
      sanitizedReferences.push(id);
    }

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

    await assertOwns("project", projectId, userId);

    for (const refId of sanitizedReferences) {
      await assertOwnsAny(["workflow", "character", "element", "media"], refId, userId);
    }

    if (parameters && typeof parameters === "object") {
      for (const field of MEDIA_PARAM_KEYS) {
        for (const mediaRefId of toMediaIdList(parameters[field])) {
          if (!mediaRefId.startsWith("http")) {
            await assertOwnsAny(["workflow", "media"], mediaRefId, userId);
          }
        }
      }
    }

    const mediaMeta = defaultAspectRatio
      ? resolveMediaMetadata({ parameters, ...req.body }, defaultAspectRatio)
      : resolveMediaMetadata({ parameters, ...req.body });
    const rawFolderId =
      req.body.folder_id ||
      req.body.folderId ||
      req.body.collection_id ||
      req.body.collectionId ||
      null;

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestGeneration({
      userId,
      mediaType,
      stepId,
      useCaseId,
      prompt,
      model: chosenModel,
      projectId,
      folderId: rawFolderId,
      references: sanitizedReferences,
      parameters,
      mediaMeta,
      outputCount: 1,
      defaultMessages,
    });

    return res.json(result);
  } catch (err) {
    return sendGenerationControllerError(res, err, {
      logger,
      actionName,
      fallbackMessage: fallbackErrorMessage,
    });
  }
}
