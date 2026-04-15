import express from "express";
import { resolveImageTreatment } from "../lib/imageTreatmentResolver.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";

const router = express.Router();

/**
 * POST /api/lighting/change-lighting
 * Relight an existing image with new lighting parameters.
 */
router.post("/change-lighting", async (req, res) => {
    try {
        const {
            angle, elevation, intensity, type, brightness, color,
            project_id, session_id, workflow_id, media_id,
            references,
            model_name,
            ratio,
            quality,
        } = req.body;

        const normalizedModelName = normalizeImageModelName(model_name) || "seedream-pro";

        console.log("[LightingRoute] body:", req.body);

        if (!references || !references.length) {
            return res.status(400).json({ ok: false, message: "Original image reference is required" });
        }

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        // 1. Resolve Project and Session
        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        // 2. Resolve specialized Lighting Treatment
        const treatment = resolveImageTreatment("lighting");

        // 3. Execute with raw parameters
        const result = await treatment.execute({
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
            media_id,
            references,
            model_name: normalizedModelName,
            userId,
        });

        res.json({
            ok: true,
            ...result,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [ChangeLighting] error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
});

export default router;
