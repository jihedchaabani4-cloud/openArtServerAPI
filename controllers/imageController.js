import { randomUUID } from "node:crypto";
import { db, useCaseService } from "../src/container.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const controllerLogger = createLogger("controller");

import { resolveMediaMetadata } from "../src/platform/media/mediaMetadataResolver.js";
import { assertOwns, assertOwnsAny } from "../src/platform/security/ownership.js";

/**
 * POST /api/images/generated
 *
 * Pure HTTP Controller — Image Generation.
 *
 * Architecture:
 *   - Accepts model-specific params as an opaque `parameters` object.
 *   - Does NOT know or map individual model params (quality, resolution, etc.).
 *   - Model Management is the source of truth for parameter validation + mapping.
 *
 * Request shape:
 *   {
 *     prompt:     string (required)
 *     model:      string (required)
 *     references: string[]  (workflow IDs only — no raw URLs)
 *     parameters: object    (model-specific, pass-through)
 *     project_id: string (required)
 *     session_id: string (optional)
 *   }
 *
 * Flow:
 *   1. Validate request shape.
 *   2. Create Workflow + Media placeholder rows in DB.
 *   3. Reserve credits & enqueue UseCase job.
 *   4. Return { workflowId, mediaId, taskId, status: "processing" }.
 */
export async function generateImage(req, res) {
  let workflowId = null;
  let mediaId    = null;
  try {
    const { prompt, model, references = [], parameters = {} } = req.body;
    const projectId = req.body.project_id || req.body.projectId || null;
    const sessionId = req.body.session_id || req.body.sessionId || null;

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
    if (Array.isArray(references)) {
      for (const ref of references) {
        const id = (typeof ref === "string" ? ref.trim()
          : (ref?.workflow_id || ref?.workflowId || ref?.id || "")).trim();
        if (id.startsWith("http://") || id.startsWith("https://")) {
          return res.status(400).json({
            ok: false,
            message: "Direct image URLs are not permitted in references. Use workflow IDs only.",
          });
        }
        if (id) sanitizedReferences.push(id);
      }
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
      if (parameters.input_image && typeof parameters.input_image === "string" && !parameters.input_image.startsWith("http")) {
        await assertOwnsAny(["workflow", "media"], parameters.input_image.trim(), userId);
      }
      if (Array.isArray(parameters.images)) {
        for (const img of parameters.images) {
          const imgId = typeof img === "string" ? img : (img?.workflow_id || img?.id);
          if (typeof imgId === "string" && !imgId.startsWith("http")) {
            await assertOwnsAny(["workflow", "media"], imgId.trim(), userId);
          }
        }
      }
    }

    workflowId   = randomUUID();
    mediaId      = randomUUID();

    // ── 1. Create Workflow container ─────────────────────────────────────────
    await db.workflows.createWorkflow({
      id:            workflowId,
      project_id:    projectId,
      session_id:    sessionId,
      display_name:  prompt.slice(0, 60),
      workflow_type: "GENERATION",
    });

    controllerLogger.info({ workflowId, projectId }, `Workflow created: ${workflowId}`);

    // ── 2. Create Media placeholder ──────────────────────────────────────────
    const mediaMeta = resolveMediaMetadata({ parameters, ...req.body });

    await db.media.createMedia({
      id:          mediaId,
      workflow_id: workflowId,
      project_id:  projectId,
      step_id:     "image_generation",
      url:         null,
      width:       mediaMeta.width,
      height:      mediaMeta.height,
      status:      "processing",
    });

    controllerLogger.info({ mediaId, workflowId }, `Media placeholder created: ${mediaId}`);

    // ── 3. Prepare UseCase runtime input ─────────────────────────────────────
    // Only workflow-level fields at root. All model-specific params are in `parameters`.
    const runtimeInput = {
      prompt:      prompt.trim(),
      model:       chosenModel,
      references:  sanitizedReferences,
      parameters:  (parameters && typeof parameters === "object") ? parameters : {},
      project_id:  projectId,
      workflow_id: workflowId,
      media_id:    mediaId,
    };


    // ── 4. Credit reservation & Redis job dispatch ────────────────────────────
    let taskId               = null;
    let hasSufficientCredits = true;
    let creditErrorMsg       = null;
    let calculatedCost       = null;

    try {
      controllerLogger.debug({ workflowId, useCase: "image-generation-v1" }, "Preparing & reserving credits");
      const prepared = await useCaseService.prepareAndEnqueue({
        useCaseId:   "image-generation-v1",
        input:       runtimeInput,
        userId,
        executionId: workflowId,
        traceId:     workflowId,
      });
      taskId         = prepared.jobId || prepared.executionId || workflowId;
      calculatedCost = prepared.cost?.totalCredits ?? null;
      controllerLogger.info({ calculatedCost, taskId }, `Reserved ${calculatedCost} credits & enqueued job "${taskId}"`);
    } catch (serviceErr) {
      // ── Distinguish error types — Controller only routes, never retries ──────
      if (serviceErr.code === "INSUFFICIENT_CREDITS" || serviceErr.code === "BILLING_HOLD_REQUIRED") {
        // Business error: user doesn't have enough credits
        hasSufficientCredits = false;
        creditErrorMsg       = serviceErr.message;
        controllerLogger.warn({ workflowId, code: serviceErr.code }, `Billing error: ${serviceErr.message}`);
      } else if (serviceErr.code === "QUEUE_DISPATCH_FAILED") {
        // Infrastructure error: queue unavailable after all retries + credits already rolled back by UseCaseService
        controllerLogger.error({ workflowId, code: serviceErr.code }, `Queue dispatch failed: ${serviceErr.message}`);
        if (mediaId && db?.media) {
          await db.media.updateMedia(mediaId, {
            status: "failed",
            error_message: serviceErr.message,
          }).catch(() => {});
        }
        return res.status(503).json({
          ok:         false,
          status:     "failed",
          code:       "QUEUE_DISPATCH_FAILED",
          message:    serviceErr.message,
          workflowId,
          mediaId,
        });
      } else {
        // Unknown service error — propagate to outer catch → HTTP 500
        throw serviceErr;
      }
    }

    if (!hasSufficientCredits && mediaId && db?.media) {
      await db.media.updateMedia(mediaId, {
        status: "saved",
        error_message: creditErrorMsg || "Insufficient credits",
      }).catch(() => {});
    }

    // ── 5. Return response ────────────────────────────────────────────────────
    return res.json({
      ok:           true,
      status:       hasSufficientCredits ? "processing" : "saved",
      needsCredits: !hasSufficientCredits,
      message:      hasSufficientCredits
        ? "Image generation started."
        : (creditErrorMsg || "Add credits to generate your image."),
      cost:         calculatedCost,
      workflowId,
      mediaId,
      taskId,
      project_id:  projectId,
      session_id:  sessionId,
      workflow:    { id: workflowId, primary_media_id: mediaId, workflow_type: "GENERATION" },
    });

  } catch (err) {
    const statusCode = err.statusCode || 500;
    controllerLogger.error({ err, statusCode }, `generateImage error: ${err.message}`);
    if (mediaId && db?.media) {
      await db.media.updateMedia(mediaId, {
        status: "failed",
        error_message: err.message || "Failed to prepare generation request",
      }).catch(() => {});
    }
    return res.status(statusCode).json({
      ok: false,
      message: err.isOperational ? err.message : "Failed to generate image",
    });
  }
}


