import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { useCaseService } from "../src/container.js";

/**
 * POST /api/upscale
 * Dispatches upscale request via upscale-v1 UseCase with upfront credit hold and BullMQ queue.
 */
export const upscale = async (req, res) => {
    try {
        const {
            workflow_id,
            source_asset = null,
            source_url = null,
            model,
            model_name,
            factor,
            project_id,
            session_id,
        } = req.body;

        const rawModel = (model || model_name || "").trim();
        if (!rawModel) {
            return res.status(400).json({ ok: false, message: "model is required for upscale." });
        }

        const normalizedModelName = normalizeImageModelName(rawModel);
        if (!normalizedModelName) {
            return res.status(400).json({ ok: false, message: `Model "${rawModel}" not found.` });
        }

        const resolvedSourceUrl = source_url || source_asset?.url || (typeof source_asset === "string" ? source_asset : null);
        if (!resolvedSourceUrl) {
            return res.status(400).json({ ok: false, message: "source_asset (or source_url) is required for upscale." });
        }

        const userId = req.user.id;

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const runtimeInput = {
            model: normalizedModelName,
            source_url: resolvedSourceUrl,
            source_asset: source_asset,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id: workflow_id || null,
        };

        if (factor !== undefined && factor !== null) runtimeInput.factor = Number(factor);

        const prepared = await useCaseService.prepareAndEnqueue({
            useCaseId: "upscale-v1",
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
        console.error("❌ [upscaleController] upscale error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
