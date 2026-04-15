import express from "express";
import { resolveImageTreatment } from "../lib/imageTreatmentResolver.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { editVideoTreatment, promptService } from "../src/container.js";
import { CameraTask } from "../src/video/tasks/CameraTask.js";

const router = express.Router();

// ── POST /api/camera/change-angles ─────────────────────────────────────────
// Unified endpoint. Routes to image or video camera treatment based on
// `media_type` field ("image" | "video"). Defaults to "image".
//
// Image body:
//   { media_type: "image", rotation, tilt, zoom, references, model_name, ratio, quality, ... }
//
// Video body:
//   { media_type: "video", camera_text: "slow zoom in", model, workflow_id, media_id, ... }
//
router.post("/change-angles", async (req, res) => {
    const media_type = (req.body.media_type || "image").toLowerCase();

    if (media_type === "video") {
        return handleVideoCamera(req, res);
    }
    return handleImageCamera(req, res);
});

// ── POST /api/camera/video ──────────────────────────────────────────────────
// Dedicated video camera-edit shortcut (same as change-angles with media_type=video)
router.post("/video", (req, res) => handleVideoCamera(req, res));

// ── POST /api/camera/image ──────────────────────────────────────────────────
// Dedicated image camera shortcut
router.post("/image", (req, res) => handleImageCamera(req, res));


// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

async function handleImageCamera(req, res) {
    try {
        const {
            rotation, tilt, zoom,
            project_id, session_id, workflow_id, media_id,
            references,
            model_name,
            ratio,
            quality
        } = req.body;

        if (!references || !references.length) {
            return res.status(400).json({ ok: false, message: "Original image reference is required" });
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";
        const normalizedModelName = normalizeImageModelName(model_name) || "seedream-pro";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const treatment = resolveImageTreatment("camera");

        const result = await treatment.execute({
            rotation, tilt, zoom,
            ratio,
            quality: quality || "1k",
            project_id:  finalProjectId,
            session_id:  finalSessionId,
            workflow_id,
            media_id,
            references,
            model_name: normalizedModelName,
            userId,
        });

        return res.json({
            ok: true,
            media_type: "image",
            ...result,
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
            camera_text,
            prompt        = "",
            ratio         = "16:9",
            duration      = "5s",
            references    = [],
            project_id,
            session_id,
            is_new_project,
            workflow_id,
            media_id,
        } = req.body;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required for video camera edit." });
        }

        const rawCameraText = (camera_text || "").trim();
        if (!rawCameraText) {
            return res.status(400).json({ ok: false, message: "camera_text is required. Describe the camera move (e.g. 'slow zoom in')." });
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

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

        const result = await editVideoTreatment.execute({
            model,
            prompt: finalPrompt,
            cameraControl: cameraControl,
            camera_control: cameraControl,
            ratio,
            duration,
            references,
            project_id:    finalProjectId,
            session_id:    finalSessionId,
            workflow_id,
            media_id,
            userId,
            edit_type:     "camera",
        });

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
