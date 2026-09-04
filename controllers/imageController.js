import { randomUUID } from "node:crypto";
import { db, useCaseService } from "../src/container.js";
import { createLogger, LogEvents } from "../src/infrastructure/logging/index.js";

const controllerLogger = createLogger("controller");



/**
 * POST /api/images/generated
 *
 * 🌟 Pure HTTP Controller — Image Generation:
 * 1. Creates Workflow container row in DB.
 * 2. Creates Media placeholder row (status: processing).
 * 3. Prechecks credits — if insufficient, returns early with needsCredits flag.
 * 4. Enqueues UseCase job to Redis worker (image-generation-v1).
 * 5. Returns { workflowId, mediaId, taskId, status: "processing" }.
 */
export async function generateImage(req, res) {
    try {
        const { prompt, references = [], ratio, model, quality, count } = req.body;
        const projectId  = req.body.project_id  || req.body.projectId  || null;
        const sessionId  = req.body.session_id  || req.body.sessionId  || null;

        if (!prompt?.trim()) {
            return res.status(400).json({ ok: false, message: "prompt is required" });
        }
        if (!projectId) {
            return res.status(400).json({ ok: false, message: "project_id is required" });
        }

        const chosenModel  = (model || req.body.model_name || "").trim();
        if (!chosenModel) {
            return res.status(400).json({ ok: false, message: "model is required" });
        }

        const userId       = req.user.id;
        const workflowId   = randomUUID();
        const mediaId      = randomUUID();

        // ── 1. Create Workflow container ──────────────────────────────────────
        const workflow = await db.workflows.createWorkflow({
            id:            workflowId,
            project_id:    projectId,
            session_id:    sessionId,
            display_name:  prompt.slice(0, 60),
            workflow_type: "GENERATION",
        });

        controllerLogger.info({ workflowId, projectId }, `Workflow created: ${workflowId}`);

        // ── 2. Calculate placeholder dimensions safely ───────────────────────
        let placeholderWidth = 1024;
        let placeholderHeight = 1024;

        switch (String(ratio || "").trim()) {
            case "16:9": placeholderWidth = 1344; placeholderHeight = 768; break;
            case "9:16": placeholderWidth = 768; placeholderHeight = 1344; break;
            case "4:3":  placeholderWidth = 1152; placeholderHeight = 864; break;
            case "3:4":  placeholderWidth = 864; placeholderHeight = 1152; break;
            case "21:9": placeholderWidth = 1536; placeholderHeight = 640; break;
            case "1:1":
            default:     placeholderWidth = 1024; placeholderHeight = 1024; break;
        }

        const media = await db.media.createMedia({
            id:          mediaId,
            workflow_id: workflowId,
            project_id:  projectId,
            step_id:     "image_generation",
            url:         null,
            width:       placeholderWidth,
            height:      placeholderHeight,
            status:      "processing",
        });

        controllerLogger.info({ mediaId, workflowId }, `Media placeholder created: ${mediaId}`);

        // ── 3. Prepare UseCase runtime input ─────────────────────────────────
        const runtimeInput = {
            prompt:      prompt.trim(),
            references:  Array.isArray(references) ? references : [],
            model:       chosenModel,
            project_id:  projectId,
            workflow_id: workflowId,
        };

        if (ratio) runtimeInput.ratio = ratio;
        const rawQuality = quality || req.body.resolution;
        if (rawQuality) runtimeInput.quality = String(rawQuality).trim().toLowerCase();
        const rawCount = count || req.body.num_images;
        if (rawCount) runtimeInput.count = Number(rawCount);

        // ── 4. Credit reservation & Redis job dispatch (Upfront Hold) ───────
        let taskId = null;
        let hasSufficientCredits = true;
        let creditErrorMsg = null;
        let calculatedCost = null;

        try {
            controllerLogger.debug({ workflowId, useCase: "image-generation-v1" }, "Preparing & reserving credits (UseCase: image-generation-v1)");
            const prepared = await useCaseService.prepareAndEnqueue({
                useCaseId:   "image-generation-v1",
                input:       runtimeInput,
                userId,
                executionId: workflowId,
                traceId:     workflowId,
            });

            taskId = prepared.jobId || prepared.executionId || workflowId;
            calculatedCost = prepared.cost?.totalCredits ?? null;
            controllerLogger.info({ calculatedCost, taskId }, `Reserved ${calculatedCost} credits & enqueued job "${taskId}"`);

        } catch (creditErr) {
            controllerLogger.warn({ workflowId, err: creditErr }, `Prepare/enqueue failed: ${creditErr.message}`);
            hasSufficientCredits = false;
            creditErrorMsg = creditErr.message;
        }

        // ── 5. Return response ────────────────────────────────────────────────
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
        controllerLogger.error({ err }, `generateImage error: ${err.message}`);
        return res.status(500).json({ ok: false, message: err.message });
    }
}
