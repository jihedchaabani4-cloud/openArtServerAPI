// controllers/videoController.js — HTTP handler; domain treatment: src/video/treatments/VideoTreatment.js
import { videoTreatment, motionTreatment, editVideoTreatment, promptService } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { isVideoModelRegistered } from "../lib/modelRegistryKeys.js";

/**
 * generateVideo
 * POST /api/video/generated (canonical)
 * POST /api/video/generate  (deprecated alias)
 */
export const generateVideo = async (req, res) => {
    try {
        const {
            model,
            model_name,
            prompt,
            ratio          = "16:9",
            duration       = "5s",
            sound,
            cfgScale,
            negativePrompt = "",
            multiPrompt,
            keepOriginalSound,
            references     = [],
            project_id,
            session_id,
            is_new_project,
        } = req.body;

        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!prompt?.trim())
            return res.status(400).json({ ok: false, message: "prompt is required" });

        // ✅ Guard: reject raw Base64 references — assets must be pre-uploaded via /api/assets/upload
        const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
        if (hasBase64) {
            return res.status(400).json({
                ok: false,
                message: "Base64 references are not accepted. Please upload the asset first via POST /api/assets/upload and use the returned URL or asset_id."
            });
        }

        console.log(`\n📥 [VideoController] generate request received:`);
        console.log(`   - Model: ${activeModel ?? "(default)"}`);
        console.log(`   - Prompt: "${prompt}"`);
        console.log(`   - Ratio: ${ratio}, Duration: ${duration}`);
        console.log(`   - 📸 References Attached: ${references.length}`);

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, is_new_project);

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            sound,
            cfgScale,
            negativePrompt,
            multiPrompt,
            keepOriginalSound,
            references,
            project_id: finalProjectId,
            session_id: finalSessionId,
            userId,
        };

        let result;
        if (req.body.section === "motion" || req.body.edit_type === "motion") {
            result = await motionTreatment.execute(payload);
        } else {
            result = await videoTreatment.execute(payload);
        }

        res.json({
            ok: true,
            ...result,               // batchId, configId, workflows, status, mode, model
            data: result,            // also keep nested for backward compat
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [VideoController] generateVideo error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * extendVideo
 * POST /api/video/extend
 */
export const extendVideo = async (req, res) => {
    try {
        const {
            model,
            model_name,
            prompt,
            ratio          = "16:9",
            duration       = "5s",
            sound,
            cfgScale,
            negativePrompt = "",
            multiPrompt,
            keepOriginalSound,
            references     = [],
            project_id,
            session_id,
            is_new_project,
            workflow_id,
            media_id,
        } = req.body;

        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!workflow_id || !media_id) {
            return res.status(400).json({ ok: false, message: "workflow_id and media_id are required to extend a video." });
        }

        const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
        if (hasBase64) {
            return res.status(400).json({
                ok: false,
                message: "Base64 references are not accepted."
            });
        }

        console.log(`\n📥 [VideoController] extendVideo request received:`);
        console.log(`   - Model: ${activeModel ?? "(default)"}`);
        console.log(`   - Prompt: "${prompt}"`);
        console.log(`   - Extending workflow ID: ${workflow_id}`);

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, is_new_project);

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            sound,
            cfgScale,
            negativePrompt,
            multiPrompt,
            keepOriginalSound,
            references,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id,
            media_id,
            userId,
            edit_type: "extend",
            section: "video_generator"
        };

        let result;
        if (req.body.section === "motion" || payload.edit_type === "motion") {
            // motionTreatment is used if it's explicitly motion
            result = await motionTreatment.execute(payload);
        } else {
            result = await editVideoTreatment.execute(payload);
        }

        res.json({
            ok: true,
            ...result,               
            data: result,            
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [VideoController] extendVideo error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * editVideo
 * POST /api/video/edit
 */
export const editVideo = async (req, res) => {
    try {
        const {
            model,
            model_name,
            prompt,
            ratio          = "16:9",
            duration       = "5s",
            sound,
            cfgScale,
            negativePrompt = "",
            multiPrompt,
            keepOriginalSound,
            references     = [],
            project_id,
            session_id,
            is_new_project,
            workflow_id,
            media_id,
        } = req.body;

        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        // ── Regular Edit ─────────────────────────────────────────────────────

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required to edit a video." });
        }

        const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
        if (hasBase64) {
            return res.status(400).json({
                ok: false,
                message: "Base64 references are not accepted."
            });
        }

        console.log(`\n📥 [VideoController] editVideo request received:`);
        console.log(`   - Model: ${activeModel ?? "(default)"}`);
        console.log(`   - Prompt: "${prompt}"`);
        console.log(`   - Editing workflow ID: ${workflow_id}`);

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, is_new_project);

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            sound,
            cfgScale,
            negativePrompt,
            multiPrompt,
            keepOriginalSound,
            references,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id,
            media_id,
            userId,
            edit_type: "edit",
            section: "video_generator"
        };

        const result = await editVideoTreatment.execute(payload);

        res.json({
            ok: true,
            ...result,               
            data: result,            
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [VideoController] editVideo error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
