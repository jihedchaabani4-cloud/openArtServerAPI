// controllers/editImageController.js
// Dedicated HTTP handler for editing an existing workflow image.
// Route: POST /api/images/generated/edit/existing
// Treatment: EditImageTreatment → ImageEditTask

import { editImageTreatment } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";

/**
 * POST /api/images/generated/edit/existing
 *
 * Edits an existing workflow by generating a new media item and attaching it.
 * Supports:
 *  - Localized editing via mask_selection (Gemini bounding-box coords)
 *  - Upscale mode (activeTab === "upscale")
 *  - Full reference list (model uses them as context)
 */
export const generateEdit = async (req, res) => {
    try {
        let {
            prompt,
            negative_prompt,
            ratio,
            quality,
            resolution,
            strength,
            project_id,
            session_id,
            workflow_id,
            media_id,
            references,
            model_name,
            mask_selection,
            activeTab,
            upscaleScale,
            seed,
            steps,
            guidance_scale,
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

        // Guard: reject raw Base64 references
        if (Array.isArray(references)) {
            const hasBase64 = references.some(r => typeof r.url === "string" && r.url.startsWith("data:"));
            if (hasBase64) {
                return res.status(400).json({
                    ok: false,
                    message: "Base64 references are not accepted. Upload first via POST /api/assets/upload.",
                });
            }
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id);

        // Server-side security: edits require a completed source media in the same session/project/workflow
        await assertMediaUsable({
            media_id,
            workflow_id,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

        console.log(`\n📥 [EditImageController] Edit request received:`);
        console.log(`   - Model:      ${model_name || "default"}`);
        console.log(`   - Prompt:     "${prompt}"`);
        console.log(`   - Workflow:   ${workflow_id}`);
        console.log(`   - Media:      ${media_id || "N/A"}`);
        console.log(`   - ActiveTab:  ${activeTab || "describe"}`);
        console.log(`   - Mask:       ${mask_selection ? "yes" : "no"}`);
        console.log(`   - References: ${references?.length ?? 0}`);

        const result = await editImageTreatment.execute({
            prompt,
            negative_prompt,
            ratio,
            quality: quality || resolution,
            strength,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id,
            media_id,
            references,
            model_name,
            userId,
            mask_selection,
            activeTab,
            upscaleScale,
            seed,
            steps,
            guidance_scale,
        });

        return res.json({
            ok: true,
            ...result,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [EditImageController] Error:", error);
        return res.status(error.statusCode || 500).json({ ok: false, message: error.message });
    }
};
