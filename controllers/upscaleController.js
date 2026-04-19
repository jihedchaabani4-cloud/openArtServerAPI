import { upscaleTreatment, db } from "../src/container.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";

export const upscale = async (req, res) => {
    try {
        const { 
            workflow_id,
            upscaleScale,
            target_resolution,
            target_fps,
        } = req.body;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        // Resolve media, project and session from workflow on the server
        const sourceMedia = await db.media.findLatestByWorkflow(workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "No media found for this workflow" });
        }

        const { media_id, project_id, session_id } = sourceMedia;

        // Server-side security: verify media is usable before upscaling
        await assertMediaUsable({
            media_id,
            workflow_id,
            project_id,
            session_id,
        });

        const result = await upscaleTreatment.execute({
            project_id,
            session_id,
            workflow_id,
            media_id,
            upscaleScale,
            target_resolution,
            target_fps,
            userId,
        });

        res.json({ 
            ok: true, 
            ...result,
            project_id,
            session_id,
        });

    } catch (error) {
        console.error("❌ [UpscaleController] upscale error:", error);
        res.status(error.statusCode || 500).json({ ok: false, message: error.message });
    }
};
