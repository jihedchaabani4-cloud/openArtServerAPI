import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";

// V2 & UseCase Imports
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { walletService, pricingService } from "../src/container.js";

/**
 * POST /api/images/edit
 * Dispatches image edit via edit-image-v1 UseCase.
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

        if (!prompt) {
            return res.status(400).json({ ok: false, message: "Prompt is required for edit." });
        }

        const userId = req.user.id;
        const normalizedModelName = normalizeImageModelName(model || model_name) || "nanobana";

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const runtimeInput = {
            prompt: prompt || "",
            model: normalizedModelName,
            aspect_ratio: aspect_ratio || ratio || "1:1",
            quality: "standard",
            strength: strength,
            source_asset: source_asset,
            source_url: source_asset?.url || source_asset || null,
            mode: "image_edit",
            project_id: finalProjectId,
            session_id: finalSessionId,
        };

        const runResult = await runUseCase({
            useCaseId: "image-edit-v1",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
        });

        res.json({
            ok: true,
            status: "processing",
            taskId: runResult.executionId,
            jobId: runResult.executionId,
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
