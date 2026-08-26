import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { useCaseService } from "../src/container.js";

/**
 * POST /api/images/edit
 * Dispatches image edit via image-edit-v1 UseCase.
 */
export const generateEdit = async (req, res) => {
    try {
        const {
            workflow_id,
            prompt,
            model_name,
            model,
            ratio,
            aspect_ratio,
            project_id,
            session_id,
            strength = 0.75,
            source_asset = null
        } = req.body;

        if (!prompt?.trim()) {
            return res.status(400).json({ ok: false, message: "Prompt is required for edit." });
        }

        const rawModel = (model || model_name || "").trim();
        if (!rawModel) {
            return res.status(400).json({ ok: false, message: "model is required for edit." });
        }

        const normalizedModelName = normalizeImageModelName(rawModel);
        if (!normalizedModelName) {
            return res.status(400).json({ ok: false, message: `Model "${rawModel}" not found.` });
        }

        const sourceUrl = source_asset?.url || (typeof source_asset === "string" ? source_asset : null);
        if (!sourceUrl) {
            return res.status(400).json({ ok: false, message: "source_asset (or source_url) is required for edit." });
        }

        const userId = req.user.id;

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const runtimeInput = {
            prompt: prompt.trim(),
            model: normalizedModelName,
            aspect_ratio: aspect_ratio || ratio || "1:1",
            quality: "standard",
            strength: strength,
            source_asset: source_asset,
            source_url: sourceUrl,
            mode: "image_edit",
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id: workflow_id || null,
        };

        const prepared = await useCaseService.prepareAndEnqueue({
            useCaseId: "image-edit-v1",
            input: runtimeInput,
            userId,
        });

        res.json({
            ok: true,
            status: "processing",
            taskId: prepared.jobId || prepared.executionId,
            jobId: prepared.jobId || prepared.executionId,
            cost: prepared.cost?.totalCredits,
            batchId: null,
            configId: null,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [editImageController] generateEdit error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
