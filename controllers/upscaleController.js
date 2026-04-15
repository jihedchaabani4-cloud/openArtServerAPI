import { upscaleTreatment, db } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";

export const upscale = async (req, res) => {
    try {
        let { 
            project_id,
            session_id,
            workflow_id,
            media_id,
            upscaleScale,
            target_resolution,
            target_fps,
        } = req.body;

        if (!media_id) {
            return res.status(400).json({ ok: false, message: "media_id is required" });
        }

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        // Auto-resolve context from media if not provided by frontend
        if (!project_id || !session_id || !workflow_id) {
            const sourceMedia = await db.media.findById(media_id);
            if (sourceMedia) {
                project_id  = project_id  || sourceMedia.project_id;
                session_id  = session_id  || sourceMedia.session_id;
                workflow_id = workflow_id || sourceMedia.workflow_id;
            }
        }

        const { project_id: finalProjectId, session_id: finalSessionId } = 
            await autoCreateProjectAndSession(userId, project_id, session_id);

        // Server-side security: don't allow upscale unless the source media is usable
        await assertMediaUsable({
            media_id,
            workflow_id: workflow_id || null,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

        const result = await upscaleTreatment.execute({
            project_id: finalProjectId,
            session_id: finalSessionId,
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
            project_id: finalProjectId,
            session_id: finalSessionId
        });

    } catch (error) {
        console.error("❌ [UpscaleController] upscale error:", error);
        res.status(error.statusCode || 500).json({ ok: false, message: error.message });
    }
};
