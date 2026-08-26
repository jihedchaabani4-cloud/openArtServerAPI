import { autoCreateProjectAndSession } from "../lib/helpers.js";
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
            factor = 2,
            project_id,
            session_id,
        } = req.body;

        const userId = req.user.id;

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const runtimeInput = {
            source_asset: source_asset,
            factor: factor,
            project_id: finalProjectId,
            session_id: finalSessionId,
            workflow_id: workflow_id || null,
        };

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
