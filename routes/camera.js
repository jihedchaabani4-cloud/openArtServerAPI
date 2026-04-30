import express from "express";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { editVideoTreatment, promptService, cameraTreatment } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { CameraTask } from "../src/video/tasks/CameraTask.js";

const router = express.Router();

router.use(requireAuth);

// ── POST /api/camera/change-angles ─────────────────────────────────────────
router.post("/change-angles", async (req, res) => {
    const media_type = (req.body.media_type || "image").toLowerCase();

    if (media_type === "video") {
        return handleVideoCamera(req, res);
    }
    return handleImageCamera(req, res);
});

// ── POST /api/camera/video ──────────────────────────────────────────────────
router.post("/video", (req, res) => handleVideoCamera(req, res));

// ── POST /api/camera/image ──────────────────────────────────────────────────
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
            ratio,
            quality
        } = req.body;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const userId = req.user.id;
        const normalizedModelName = normalizeImageModelName(model_name) || "gpt-image-2";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const treatment = cameraTreatment;

        const queued = await treatment.execute({
            rotation, tilt, zoom,
            ratio,
            quality: quality || "1k",
            project_id:  finalProjectId,
            session_id:  finalSessionId,
            workflow_id: workflow_id,
            reference_workflow_ids,

            model_name: normalizedModelName,
            userId,
        });

        return res.json({
            ok: true,
            media_type: "image",
            batchId: queued.batchId || null,
            configId: queued.configId,
            workflows: queued.workflows,
            status: queued.status,
            provider: queued.provider,
            project_id: finalProjectId,
            session_id: finalSessionId,
            taskId: queued.jobId,
            jobId: queued.jobId,
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
            camera_text,
            prompt        = "",
            ratio         = "16:9",
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

        console.log(`\n🎥 [Camera/Video] Target move: "${rawCameraText}"`);
        const cameraTask = new CameraTask({ promptService });
        const { cameraPrompt, cameraControl } = await cameraTask.execute({ cameraText: rawCameraText });
        const finalPrompt = CameraTask.mergeIntoPrompt(prompt, cameraPrompt);
        console.log("cameraPrompt", cameraPrompt);
        console.log("cameraControl", cameraControl);
        console.log("finalPrompt", finalPrompt);
        console.log(`   - Resolved camera_prompt: "${cameraPrompt}"`);
        console.log(`   - Resolved cameraControl: ${JSON.stringify(cameraControl)}`);
        console.log(`   - Final Prompt for edit:  "${finalPrompt}"`);

        const queued = await editVideoTreatment.execute({
            model,
            prompt: finalPrompt,
            cameraControl: cameraControl,
            camera_control: cameraControl,
            ratio,
            duration,
            references,
            project_id:    finalProjectId,
            session_id:    finalSessionId,
            video_workflow_id: finalWfId,
            reference_workflow_ids: references.map(r => r.workflow_id || r.id || r.media_id || r.asset_id).filter(Boolean),
            userId,
        });

        const result = {
            batchId:   queued.batchId ?? null,
            configId:  queued.configId,
            workflows: queued.workflows,
            status:    queued.status,
            mode:      queued.mode,
            model:     queued.model,
            taskId:    queued.jobId,
            jobId:     queued.jobId,
        };

        return res.json({
            ok: true,
            media_type: "video",
            ...result,
            data:       result,
            project_id: finalProjectId,
            session_id: finalSessionId,
            camera_prompt: cameraPrompt,
            camera_control: cameraControl,
        });

    } catch (error) {
        console.error("❌ [Camera/Video] error:", error);
        return res.status(500).json({ ok: false, message: error.message });
    }
}

export default router;
