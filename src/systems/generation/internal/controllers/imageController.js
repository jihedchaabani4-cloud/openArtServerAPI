import { randomUUID } from "node:crypto";
import { getGenerationServices } from "../services/serviceAccessor.js";
import {
  IMAGE_EDIT_MODELS,
  parseRelightRequest,
  parseAnglesRequest,
  parseRemoveBackgroundRequest,
  parseImageEditRequest,
} from "../services/imageEditContract.js";
import { createLogger } from "#shared";
import { resolveMediaMetadata } from "#media/tools";
import { assertOwns, assertOwnsAny, toMediaIdList } from "#identity/tools";

const controllerLogger = createLogger("controller");

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
 * POST /api/images/generated
 *
 * Pure HTTP Controller — Image Generation.
 *
 * Architecture:
 *   - Accepts model-specific params as an opaque `parameters` object.
 *   - Validates HTTP request shape, permissions, and media-specific constraints.
 *   - Delegates domain orchestration, placeholder persistence, and job dispatch to GenerationRequestService.
 */
export async function generateImage(req, res) {
  try {
    const { prompt, model, references = [], parameters = {} } = req.body;
    const projectId = req.body.project_id || req.body.projectId || null;

    // ── Shape validation ─────────────────────────────────────────────────────

    // Reject direct image source fields — use workflow IDs in parameters.input_image
    if (req.body.image_url || req.body.source || req.body.input_image || req.body.source_url) {
      return res.status(400).json({
        ok: false,
        message: "Direct image sources are not permitted. Upload the asset via /api/assets/upload and pass the returned workflow_id in parameters.input_image.",
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
          message: "Direct image URLs are not permitted in references. Use workflow IDs only.",
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

    // ── Media-specific metadata resolution ───────────────────────────────────
    const mediaMeta = resolveMediaMetadata({ parameters, ...req.body });
    const outputCount = 1;
    const rawFolderId = req.body.folder_id || req.body.folderId || req.body.collection_id || req.body.collectionId || null;

    // ── Delegate execution to GenerationRequestService ───────────────────────
    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestGeneration({
      userId,
      mediaType: "image",
      stepId: "image_generation",
      useCaseId: "image-generation-v1",
      prompt,
      model: chosenModel,
      projectId,
      folderId: rawFolderId,
      references: sanitizedReferences,
      parameters,
      mediaMeta,
      outputCount,
      defaultMessages: {
        started: "Image generation started.",
        addCredits: "Add credits to generate your image.",
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
    controllerLogger.error({ err, statusCode }, `generateImage error: ${err.message}`);
    const traceId = err.workflowId || randomUUID();
    return res.status(statusCode).json({
      ok: false,
      code: statusCode >= 500 ? "INTERNAL_ERROR" : (err.code || "REQUEST_FAILED"),
      message: err.isOperational ? err.message : "Failed to generate image",
      traceId,
    });
  }
}

function handleImageEditError(res, err, actionName, fallbackMessage) {
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
  controllerLogger.error({ err, statusCode }, `${actionName} error: ${err.message}`);
  const traceId = err.workflowId || randomUUID();
  return res.status(statusCode).json({
    ok: false,
    code: statusCode >= 500 ? "INTERNAL_ERROR" : (err.code || "REQUEST_FAILED"),
    message: err.isOperational ? err.message : fallbackMessage,
    traceId,
  });
}

/**
 * POST /api/images/relight
 *
 * Pure HTTP Controller — In-Place Image Relight.
 * Validates flat single-light settings, verifies workflow ownership,
 * and delegates to GenerationRequestService.requestImageEdit.
 */
export async function relightImage(req, res) {
  try {
    const parsed = parseRelightRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "relight",
      stepId: "image_relight",
      useCaseId: "image-relight-v3",
      model: IMAGE_EDIT_MODELS.relight,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      editSettings: parsed.editSettings,
      templateVars: parsed.templateVars,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Image relight started.",
        addCredits: "Add credits to relight your image.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "relightImage", "Failed to relight image");
  }
}

/**
 * POST /api/images/angles
 *
 * Pure HTTP Controller — In-Place Camera Angle Edit.
 * Validates camera pose settings, verifies workflow ownership,
 * and delegates to GenerationRequestService.requestImageEdit.
 */
export async function changeImageAngle(req, res) {
  try {
    const parsed = parseAnglesRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "angles",
      stepId: "image_angles",
      useCaseId: "image-angles-v3",
      model: IMAGE_EDIT_MODELS.angles,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      editSettings: parsed.editSettings,
      templateVars: parsed.templateVars,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Image angle adjustment started.",
        addCredits: "Add credits to adjust your image angle.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "changeImageAngle", "Failed to adjust image angle");
  }
}

/**
 * POST /api/images/remove-background
 *
 * Pure HTTP Controller — In-Place Image Background Removal (Direct 2-node V3, zero LLM).
 * Allows selecting between Bria remove-background models (`bria_remove_background_3_0` or
 * `bria_remove_background_guided`), verifies workflow ownership, and delegates to
 * GenerationRequestService.requestImageEdit.
 */
export async function removeImageBackground(req, res) {
  try {
    const parsed = parseRemoveBackgroundRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "remove_background",
      stepId: "image_remove_background",
      useCaseId: "image-remove-background-v3",
      model: parsed.model,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      editSettings: parsed.editSettings,
      templateVars: parsed.templateVars,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Background removal started.",
        addCredits: "Add credits to remove background from your image.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "removeImageBackground", "Failed to remove image background");
  }
}

/**
 * POST /api/images/edit
 *
 * Pure HTTP Controller — General In-Place Image Edit.
 * Allows selecting any active edit-capable image model, validates prompt + optional references,
 * verifies workflow and reference ownership, and delegates to GenerationRequestService.requestImageEdit.
 */
export async function editImage(req, res) {
  try {
    const parsed = parseImageEditRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    for (const refId of parsed.references) {
      await assertOwnsAny(["workflow", "character", "element", "media"], refId, userId);
    }

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "edit",
      stepId: "image_edit",
      useCaseId: "image-edit-v3",
      model: parsed.model,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      references: parsed.references,
      editSettings: parsed.editSettings,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Image edit started.",
        addCredits: "Add credits to edit your image.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "editImage", "Failed to edit image");
  }
}
