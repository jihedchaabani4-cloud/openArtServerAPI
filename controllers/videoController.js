// controllers/videoController.js — HTTP handler; domain treatment: src/video/treatments/VideoTreatment.js
import { videoTreatment, motionTreatment, editVideoTreatment, promptService } from "../src/container.js";
import { isVideoModelRegistered } from "../lib/modelRegistryKeys.js";
import { getTaskService } from "../src/services/redis-management/index.js";

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
            negativePrompt = "",
            multiPrompt,
            keepOriginalSound,
            references     = [],
            reference_workflow_ids = [],
            image_workflow_id,
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

        const finalProjectId = project_id;
        const finalSessionId = session_id;

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            sound,
            negativePrompt,
            multiPrompt,
            keepOriginalSound,
            references,
            image_workflow_id,
            reference_workflow_ids,
            project_id: finalProjectId,
            session_id: finalSessionId,
            userId,
        };

        const prepared = await videoTreatment.prepare(payload);
        const task = await getTaskService().createTask({
            userType: req.user?.plan || "normal",
            userId: req.user.id,
            workflow_id: prepared.workflow.id,
            runner: "video",
            data: prepared
        });

        const result = {
            batchId:   prepared.batchId,
            configId:  prepared.configId,
            workflows: prepared.workflows,
            status:    "processing",
            mode:      prepared.mode,
            model:     prepared.model_name,
            taskId:    task.id,
        };

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
            negativePrompt = "",
            multiPrompt,
            keepOriginalSound,
            workflow_id,
            video_workflow_id,
            reference_workflow_ids = [],
            project_id,
            session_id,
            media_id,
        } = req.body;

        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const finalWfId = video_workflow_id || workflow_id;
        if (!finalWfId || !media_id) {
            return res.status(400).json({ ok: false, message: "video_workflow_id and media_id are required to extend a video." });
        }

        const references = req.body.references || [];
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

        const finalProjectId = project_id;
        const finalSessionId = session_id;

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            sound,
            negativePrompt,
            multiPrompt,
            keepOriginalSound,
            references,
            project_id: finalProjectId,
            session_id: finalSessionId,
            video_workflow_id: video_workflow_id || workflow_id,
            reference_workflow_ids,
            userId,
            section: "video_generator"
        };

        const prepared = await editVideoTreatment.prepare(payload);
        const task = await getTaskService().createTask({
            userType: req.user?.plan || "normal",
            userId: userId,
            workflow_id: prepared.workflow.id,
            runner: "edit_video",
            data: prepared
        });

        const result = {
            batchId:   prepared.batchId,
            configId:  prepared.configId,
            workflows: prepared.workflows,
            status:    "processing",
            mode:      prepared.mode,
            model:     prepared.model_name,
            taskId:    task.id,
        };

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
            negativePrompt = "",
            multiPrompt,
            keepOriginalSound,
            workflow_id,
            video_workflow_id,
            reference_workflow_ids = [],
            project_id,
            session_id,
            media_id,
        } = req.body;

        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        // ── Regular Edit ─────────────────────────────────────────────────────

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const finalWfId = video_workflow_id || workflow_id;
        if (!finalWfId) {
            return res.status(400).json({ ok: false, message: "video_workflow_id is required to edit a video." });
        }

        const references = req.body.references || [];
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

        const finalProjectId = project_id;
        const finalSessionId = session_id;

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            sound,
            negativePrompt,
            multiPrompt,
            keepOriginalSound,
            references,
            project_id: finalProjectId,
            session_id: finalSessionId,
            video_workflow_id: video_workflow_id || workflow_id,
            reference_workflow_ids,
            userId,
            section: "video_generator"
        };

        const prepared = await editVideoTreatment.prepare(payload);
        const task = await getTaskService().createTask({
            userType: req.user?.plan || "normal",
            userId: userId,
            workflow_id: prepared.workflow.id,
            runner: "edit_video",
            data: prepared
        });

        const result = {
            batchId:   prepared.batchId,
            configId:  prepared.configId,
            workflows: prepared.workflows,
            status:    "processing",
            mode:      prepared.mode,
            model:     prepared.model_name,
            taskId:    task.id,
        };

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

/**
 * motionControl
 * POST /api/video/motion
 */
export const motionControl = async (req, res) => {
    try {
        const {
            model,
            prompt            = "",
            ratio             = "16:9",
            duration          = "5s",
            image_workflow_id,
            video_workflow_id,
            references        = [],
            project_id,
            session_id,
            reference_workflow_ids = [],
            is_new_project,
        } = req.body;

        const rawModel = (model || "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";
        const finalProjectId = project_id;
        const finalSessionId = session_id;

        // Resolve URLs
        let image_url = req.body.image_url;
        let video_url = req.body.video_url;

        // Extract from references array if available (from PromptBar)
        if (!image_url && references?.length) {
            const img = references.find(r => r.role === 'mc_image' || r.type === 'image');
            if (img) image_url = img.url;
        }
        if (!video_url && references?.length) {
            const vid = references.find(r => r.role === 'mc_video' || r.type === 'video');
            if (vid) video_url = vid.url;
        }

        // Fallback to resolving workflow IDs if URLs are still missing
        if (!image_url && image_workflow_id) {
            console.log(`🔍 [VideoController] Resolving image motion input from workflow ID...`);
            image_url = await motionTreatment.db.workflows.getPrimaryMediaUrl(image_workflow_id);
        }
        if (!video_url && video_workflow_id) {
            console.log(`🔍 [VideoController] Resolving video motion input from workflow ID...`);
            video_url = await motionTreatment.db.workflows.getPrimaryMediaUrl(video_workflow_id);
        }

        if (!image_url || !video_url) {
            return res.status(400).json({ 
                ok: false, 
                message: "Motion Control requires both an image reference and a video reference." 
            });
        }

        const payload = {
            model: activeModel,
            prompt,
            ratio,
            duration,
            image_url,
            video_url,
            project_id: finalProjectId,
            session_id: finalSessionId,
            video_workflow_id,
            image_workflow_id,
            reference_workflow_ids,
            userId,
            section: "motion"
        };

        console.log(`\n📥 [VideoController] motionControl request received:`);
        console.log(`   - Model: ${activeModel ?? "(default)"}`);
        console.log(`   - Resolved Image: ${image_url ? "Yes" : "No"}`);
        console.log(`   - Resolved Video: ${video_url ? "Yes" : "No"}`);

        const prepared = await motionTreatment.prepare(payload);
        const task = await getTaskService().createTask({
            userType: req.user?.plan || "normal",
            userId: userId,
            workflow_id: prepared.workflow.id,
            runner: "motion",
            data: prepared
        });

        const resultData = {
            batchId:   null,
            configId:  prepared.configId,
            workflows: [prepared.workflow],
            status:    "processing",
            mode:      prepared.mode,
            model:     prepared.model_name,
            taskId:    task.id,
        };

        res.json({
            ok: true,
            ...resultData,
            data: resultData,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [VideoController] motionControl error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
