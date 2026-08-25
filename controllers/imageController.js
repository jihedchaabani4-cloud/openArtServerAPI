import { randomUUID } from "node:crypto";
import { db, jobQueueService, useCaseService } from "../src/container.js";

/** Maps an aspect-ratio string to pixel dimensions (1344 long-edge baseline). */
function ratioDimensions(ratio = "1:1") {
    const MAP = {
        "1:1":  { width: 1024, height: 1024 },
        "16:9": { width: 1344, height: 768  },
        "9:16": { width: 768,  height: 1344 },
        "4:3":  { width: 1152, height: 864  },
        "3:4":  { width: 864,  height: 1152 },
        "3:2":  { width: 1152, height: 768  },
        "2:3":  { width: 768,  height: 1152 },
    };
    return MAP[ratio] || MAP["1:1"];
}

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
        const { prompt, references = [], ratio, width, height, model, model_name, quality, resolution, count, num_images } = req.body;
        const projectId  = req.body.project_id  || req.body.projectId  || null;
        const sessionId  = req.body.session_id  || req.body.sessionId  || null;

        if (!prompt?.trim()) {
            return res.status(400).json({ ok: false, message: "prompt is required" });
        }
        if (!projectId) {
            return res.status(400).json({ ok: false, message: "project_id is required" });
        }

        const userId       = req.user.id;
        const workflowId   = randomUUID();
        const mediaId      = randomUUID();
        const chosenModel  = model || model_name || null;
        const chosenQual   = quality || resolution || "standard";
        const chosenRatio  = ratio || "1:1";
        const imageCount   = Number(count || num_images || 1);

        // ── 1. Create Workflow container ──────────────────────────────────────
        const workflow = await db.workflows.createWorkflow({
            id:            workflowId,
            project_id:    projectId,
            session_id:    sessionId,
            display_name:  prompt.slice(0, 60),
            workflow_type: "GENERATION",
        });

        console.log(`✅ [imageController] Workflow created: ${workflowId}`);

        // ── 2. Create Media placeholder (status: processing) ─────────────────
        const dims = ratioDimensions(chosenRatio);
        const mediaWidth  = width  || dims.width;
        const mediaHeight = height || dims.height;

        const media = await db.media.createMedia({
            id:          mediaId,
            workflow_id: workflowId,
            project_id:  projectId,
            step_id:     "image_generation",
            url:         null,
            width:       mediaWidth,
            height:      mediaHeight,
            status:      "processing",
        });

        console.log(`✅ [imageController] Media placeholder created: ${mediaId} (${mediaWidth}x${mediaHeight})`);

        // ── 3. Prepare UseCase runtime input (dynamic parameters) ────────────
        const runtimeInput = {
            prompt:      prompt.trim(),
            references:  Array.isArray(references) ? references : [],
            ratio:       chosenRatio,
            width:       mediaWidth,
            height:      mediaHeight,
            model:       chosenModel,
            quality:     chosenQual,
            count:       isNaN(imageCount) ? 1 : Math.max(1, imageCount),
            project_id:  projectId,
            workflow_id: workflowId,
        };

        // ── 4. Credit precheck & Redis job dispatch ───────────────────────────
        let taskId = null;
        let hasSufficientCredits = true;
        let creditErrorMsg = null;

        try {
            console.log(`💳 [imageController] Prechecking credits (UseCase: image-generation-v1)...`);
            await useCaseService.precheckCredits({
                useCaseId: "image-generation-v1",
                input:     runtimeInput,
                userId,
            });
            console.log(`✅ [imageController] Credit precheck PASSED.`);

            const executionId = randomUUID();
            await jobQueueService.addUseCaseJob({
                useCaseId:   "image-generation-v1",
                input:       runtimeInput,
                userId,
                executionId,
            });
            taskId = executionId;
            console.log(`📤 [imageController] Enqueued job "${executionId}" to Redis (image-generation-v1).`);

        } catch (creditErr) {
            console.warn(`⚠️ [imageController] Credit precheck failed:`, creditErr.message);
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
            workflowId,
            mediaId,
            taskId,
            project_id:  projectId,
            session_id:  sessionId,
            workflow:    { id: workflowId, primary_media_id: mediaId, workflow_type: "GENERATION" },
        });

    } catch (err) {
        console.error(`❌ [imageController] generateImage error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}
