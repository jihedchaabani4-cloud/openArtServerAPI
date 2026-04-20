// controllers/editImageController.js
// Dedicated HTTP handler for editing an existing workflow image.
// Route: POST /api/images/generated/edit/existing
// Treatment: EditImageTreatment → ImageEditTask

import { editImageTreatment } from "../src/container.js";
import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";
import { getTaskService } from "../src/services/redis-management/index.js";

/**
 * POST /api/images/generated/edit/existing
 *
 * Edits an existing workflow by generating a new media item and attaching it.
 * Supports:
 *  - Localized editing via mask_selection (Gemini bounding-box coords)
 *  - Upscale mode (via upscaleScale)
 *  - Full reference list (model uses them as context)
 */
export const generateEdit = async (req, res) => {
    try {
        let {
            prompt,
            ratio,
            quality,
            resolution,
            project_id,
            session_id,
            workflow_id,
            reference_workflow_ids,
            model_name,
        } = req.body;

        // --- Validation ---
        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }
        if (!prompt) {
            return res.status(400).json({ ok: false, message: "prompt is required" });
        }

        // Normalize model name
        model_name = normalizeImageModelName(model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: `Model "${model_name}" not found` });
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

        const finalProjectId = project_id;
        const finalSessionId = session_id;

        // Server-side security: edits require a completed source media in the same session/project/workflow
        await assertMediaUsable({
            workflow_id,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

        console.log(`\n📥 [EditImageController] Edit request received:`);
        console.log(`   - Model:      ${model_name || "default"}`);
        console.log(`   - Prompt:     "${prompt}"`);
        console.log(`   - Workflow:   ${workflow_id}`);
        console.log(`   - Ref WFs:    ${(reference_workflow_ids || []).length}`);

        const prepared = await editImageTreatment.prepare({
            prompt,
            ratio,
            quality: quality || resolution,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id,
            reference_workflow_ids: reference_workflow_ids || [],
            model_name,
            userId,
        });

        const task = await getTaskService().createTask({
            userType:    req.user?.plan || "normal",
            userId,
            workflow_id: prepared.workflow.id,
            runner:      "image-edit",
            data:        prepared,
        });

        return res.json({
            ok: true,
            batchId:    null,
            configId:   prepared.configId,
            workflows:  [prepared.workflow],
            status:     "processing",
            taskId:     task.id,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [EditImageController] Error:", error);
        return res.status(error.statusCode || 500).json({ ok: false, message: error.message });
    }
};
