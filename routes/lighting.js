import express from "express";
import { lightingTreatment } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";

const router = express.Router();

/**
 * POST /api/lighting/change-lighting
 * Relight an existing image with new lighting parameters.
 */
router.post("/change-lighting", async (req, res) => {
    try {
        let {
            angle, elevation, intensity, type, brightness, color,
            project_id, session_id, workflow_id,
            model_name,
            ratio,
            quality,
        } = req.body;

        const normalizedModelName = normalizeImageModelName(model_name) || "seedream-pro";

        console.log("[LightingRoute] body:", req.body);

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        // 1. Resolve Project and Session
        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        // 2. Resolve specialized Lighting Treatment
        const treatment = lightingTreatment;

        // 3. Prepare task
        const queued = await treatment.execute({
            angle,
            elevation,
            intensity,
            type,
            brightness,
            color,
            ratio,
            quality: quality || "1k",
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id,
            model_name: normalizedModelName,
            userId,
        });

        res.json({
            ok: true,
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
        console.error("❌ [ChangeLighting] error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
});

export default router;
