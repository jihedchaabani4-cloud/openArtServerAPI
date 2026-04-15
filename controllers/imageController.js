// controllers/imageController.js — HTTP handlers for image-domain treatments
// Treatment classes: src/image/* — selection: lib/imageTreatmentResolver.js
import { resolveImageTreatment } from "../lib/imageTreatmentResolver.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { db } from "../src/container.js";

/**
 * generate
 * POST /api/images/generated (canonical)
 * POST /api/images/generate    (deprecated alias)
 */
export const generate = async (req, res) => {
    try {
        let { 
            prompt, negative_prompt, ratio, quality, resolution, 
            edit_type, strength, count, num_images,
            project_id, session_id,
            group_id,
            references,
            model_name,
        } = req.body;
        console.log("req.body", req.body);
        
        // Normalize aliases
        quality = quality || resolution;
        count   = count   || num_images || 1;

        console.log(`\n📥 [ImageController] generate request received:`);
        console.log(`   - Model: ${model_name || 'N/A'}`);
        console.log(`   - Prompt: "${prompt}"`);
        console.log(`   - Ratio: ${ratio || 'Default'}, Quality: ${quality || 'Default'}, Count: ${count}`);
        console.log(`   - Type: ${edit_type || 'standard'}, Section: ${req.body.section || 'N/A'}`);
        console.log(`   - 📸 References Attached:`, references ? references.length : 0);

        // group_id retry — not supported with new schema (batch/workflow model)


        model_name = normalizeImageModelName(model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!prompt) {
            return res.status(400).json({ ok: false, message: "Prompt is required" });
        }

        // ✅ Guard: reject raw Base64 references — assets must be pre-uploaded via /api/assets/upload
        if (Array.isArray(references)) {
            const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
            if (hasBase64) {
                return res.status(400).json({ 
                    ok: false, 
                    message: "Base64 references are not accepted. Please upload the asset first via POST /api/assets/upload and use the returned URL or asset_id."
                });
            }
        }

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';
        const { is_new_project } = req.body;

        const { project_id: finalProjectId, session_id: finalSessionId } = 
            await autoCreateProjectAndSession(userId, project_id, session_id, is_new_project);

        const treatment = resolveImageTreatment(edit_type || "standard", req.body.section);
        console.log(`🎨 [ImageController] Selected Treatment: ${treatment.constructor.name}`);

        const result = await treatment.execute({
            prompt,
            negative_prompt,
            ratio,
            quality,
            edit_type,
            strength,
            count,
            project_id: finalProjectId,
            session_id: finalSessionId,
            references,
            model_name,
            userId,
        });

        // Flatten result so batchId / workflows / status are at top level
        res.json({ 
            ok: true,
            ...result,               // batchId, configId, workflows, status, provider
            data: result,            // also keep nested for backward compat
            project_id: finalProjectId,
            session_id: finalSessionId
        });

    } catch (error) {
        console.error("❌ [ImageController] generate error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * edit - POST /api/images/edit
 */
export const edit = async (req, res) => {
    try {
        let { 
            prompt, image_base64, edit_type, strength, 
            ratio, resolution, references, model_name 
        } = req.body;

        model_name = normalizeImageModelName(model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!prompt || !image_base64) {
            return res.status(400).json({ ok: false, message: "Prompt and image_base64 are required" });
        }

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        const { project_id: finalProjectId, session_id: finalSessionId } = 
            await autoCreateProjectAndSession(userId, req.body.project_id, req.body.session_id);

        const treatment = resolveImageTreatment(edit_type || "img2img", req.body.section);

        const result = await treatment.execute({
            prompt,
            image_base64,
            media_id: req.body.media_id,
            workflow_id: req.body.workflow_id,
            edit_type: edit_type || "img2img",
            strength,
            ratio,
            resolution,
            project_id: finalProjectId,
            session_id: finalSessionId,
            references,
            model_name,
            userId,
        });

        res.json({ 
            ok: true, 
            data: result,
            project_id: finalProjectId,
            session_id: finalSessionId
        });

    } catch (error) {
        console.error("❌ [ImageController] edit error:", error);
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

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        const { project_id: finalProjectId, session_id: finalSessionId } = 
            await autoCreateProjectAndSession(userId, project_id, session_id);

        const treatment = resolveImageTreatment("edit", req.body.section);

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
            project_id: finalProjectId,
            session_id: finalSessionId
        });

    } catch (error) {
        console.error("❌ [ImageController] generateEdit error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
