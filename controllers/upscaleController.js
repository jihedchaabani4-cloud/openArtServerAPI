import { autoCreateProjectAndSession } from "../lib/helpers.js";

// V2 & UseCase Imports
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { walletService, pricingService } from "../src/container.js";

/**
 * POST /api/upscale
 * Dispatches upscale request via upscale-v1 UseCase.
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
        };

        const runResult = await runUseCase({
            useCaseId: "upscale-v1",
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
        console.error("❌ [upscaleController] upscale error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
