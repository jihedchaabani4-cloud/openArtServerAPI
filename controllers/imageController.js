import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { db, imageTreatmentV2, editImageTreatment } from "../src/container.js";
/**
 * generateV2
 * POST /api/images/generatedV2
 * Modern flow: prepare task -> enqueue BullMQ job -> worker runs treatment
 */
export const generateV2 = async (req, res) => {
    try {
        let { 
            prompt, negative_prompt, ratio, quality, resolution, 
            edit_type, count, num_images,
            project_id, session_id,
            references,
            model_name,
        } = req.body;

        // 1. Validation & Normalization
        quality = quality || resolution;
        count   = count   || num_images || 1;

        model_name = normalizeImageModelName(model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!prompt) {
            return res.status(400).json({ ok: false, message: "Prompt is required" });
        }

        const userId = req.user.id;
        // 3. Resolve Project/Session
        const finalProjectId = project_id;
        const finalSessionId = session_id;

        console.log(`🚀 [ImageController] generateV2 | User:${userId} | Mode: Redis Queue`);

        // 4. PREPARE (Creates DB placeholders & returns JSON descriptor)
        const queued = await imageTreatmentV2.execute({
            prompt,
            negative_prompt,
            ratio,
            quality,
            edit_type,
            count,
            project_id: finalProjectId,
            session_id: finalSessionId,
            references,
            model_name,
            userId,
        });
        console.log(`✅ [ImageController] Task enqueued | BullMQ ID:${queued.jobId} | Treatment:${imageTreatmentV2.constructor.name}`);

        // 6. Respond immediately
        res.json({ 
            ok: true,
            status:    queued.status,
            taskId:    queued.jobId,
            jobId:     queued.jobId,
            batchId:   queued.batchId,
            configId:  queued.configId,
            workflows: queued.workflows,
            project_id: finalProjectId,
            session_id: finalSessionId
        });

    } catch (error) {
        console.error("❌ [ImageController] generateV2 error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};





/**
 * generateEdit - POST /api/images/generated/edit
 * Specialized for editing an existing workflow.
 */
export const generateEdit = async (req, res) => {
    try {
        let { 
            prompt, negative_prompt, ratio, quality, resolution, 
            edit_type, strength, 
            project_id, session_id, workflow_id, media_id,
            references, model_name 
        } = req.body;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        model_name = normalizeImageModelName(model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const userId = req.user.id;

        const finalProjectId = project_id;
        const finalSessionId = session_id;

        const treatment = editImageTreatment;

        const result = await treatment.execute({
            prompt,
            negative_prompt,
            ratio,
            quality: quality || resolution,
            edit_type: edit_type || "edit",
            strength,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id,
            media_id,
            references,
            model_name,
            userId,
            mask_selection: req.body.mask_selection, // Added mask_selection support
        });

        res.json({ 
            ok: true, 
            ...result,
            taskId: result.jobId,
            project_id: finalProjectId,
            session_id: finalSessionId
        });

    } catch (error) {
        console.error("❌ [ImageController] generateEdit error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
