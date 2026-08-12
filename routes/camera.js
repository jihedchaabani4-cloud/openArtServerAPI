import express from "express";
import { randomUUID } from "node:crypto";
import { db, walletService, pricingService } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { promptService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { CameraTask } from "../src/video/tasks/CameraTask.js";
import { buildCameraPrompt } from "../src/v2/utils/legacyPromptBuilders.js";

// V2 & UseCase Imports
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { resolveReferences } from "../src/image/utils/resolveReferences.js";

const router = express.Router();
router.use(requireAuth);

// ── POST /api/camera/change-angles ─────────────────────────────────────────
router.post("/change-angles", async (req, res) => {
    const media_type = (req.body.media_type || "image").toLowerCase();
    if (media_type === "video") return handleVideoCamera(req, res);
    return handleImageCamera(req, res);
});

router.post("/video", (req, res) => handleVideoCamera(req, res));
router.post("/image", (req, res) => handleImageCamera(req, res));

// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

async function handleImageCamera(req, res) {
    try {
        let {
            rotation, tilt, zoom,
            project_id, session_id, workflow_id,
            reference_workflow_ids,
            model_name,
            model,
            ratio,
            aspect_ratio,
            quality
        } = req.body;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const userId = req.user.id;
        const normalizedModelName = normalizeImageModelName(model || model_name) || "fal";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const sourceMedia = await db.media.findLatestByWorkflow(workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found." });
        }

        const resolvedReferences = await resolveReferences(db, {
            baseWorkflowId: workflow_id,
            referenceMediaIds: reference_workflow_ids,
        });

        const finalPrompt = buildCameraPrompt(rotation || 0, tilt || 0, zoom || 3);
        
        const runtimeInput = {
            prompt: finalPrompt,
            model: normalizedModelName,
            aspect_ratio: aspect_ratio || ratio || "1:1",
            quality: quality || "standard",
            strength: 0.75,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            references: resolvedReferences,
            mode: "image_edit",
            project_id: finalProjectId,
            session_id: finalSessionId,
        };

        const runResult = await runUseCase({
            useCaseId: "camera-control-v1",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
        });

        return res.json({
            ok: true,
            status: "processing",
            media_type: "image",
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            batchId: null,
            configId: null,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [Camera/Image] error:", error);
        return res.status(500).json({ ok: false, message: error.message });
    }
}

async function handleVideoCamera(req, res) {
    try {
        const {
            model,
            model_name,
            camera_text,
            prompt        = "",
            ratio         = "16:9",
            aspect_ratio,
            duration      = "5s",
            references    = [],
            project_id,
            session_id,
            is_new_project,
            workflow_id,
            video_workflow_id,
        } = req.body;

        const finalWfId = video_workflow_id || workflow_id;
        if (!finalWfId) {
            return res.status(400).json({ ok: false, message: "video_workflow_id is required for video camera edit." });
        }

        const rawCameraText = (camera_text || "").trim();
        if (!rawCameraText) {
            return res.status(400).json({ ok: false, message: "camera_text is required. Describe the camera move (e.g. 'slow zoom in')." });
        }

        const userId = req.user.id;

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, is_new_project);

        const sourceMedia = await db.media.findLatestByWorkflow(finalWfId);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found." });
        }

        const cameraTask = new CameraTask({ promptService });
        const { cameraPrompt, cameraControl } = await cameraTask.execute({ cameraText: rawCameraText });
        const finalPrompt = CameraTask.mergeIntoPrompt(prompt, cameraPrompt);
        
        const runtimeInput = {
            prompt: finalPrompt,
            model: (model || model_name || "").trim() || null,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            mode: "video_to_video",
            duration: duration,
            references: references,
            camera_control: cameraControl,
            project_id: finalProjectId,
            session_id: finalSessionId,
        };

        const runResult = await runUseCase({
            useCaseId: "camera-control-v1",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
        });

        const result = {
            ok: true,
            status: "processing",
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            batchId: null,
            configId: null,
            project_id: finalProjectId,
            session_id: finalSessionId,
        };

        return res.json({
            ...result,
            media_type: "video",
            data: result,
            camera_prompt: cameraPrompt,
            camera_control: cameraControl,
        });

    } catch (error) {
        console.error("❌ [Camera/Video] error:", error);
        return res.status(500).json({ ok: false, message: error.message });
    }
}

export default router;
