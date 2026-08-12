import { db } from "../src/container.js";

// V2 & UseCase Imports
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { walletService, pricingService } from "../src/container.js";

/**
 * POST /api/character/sheets
 * Create character reference sheet via character-sheet-v1 UseCase.
 */
export async function createCharacterSheet(req, res) {
    try {
        const {
            project_id,
            prompt,
            model,
            model_name,
            features,
            references = []
        } = req.body;

        if (!project_id) {
            return res.status(400).json({ ok: false, message: "project_id is required" });
        }

        const userId = req.user.id;
        const runtimeInput = {
            prompt: prompt || "",
            model: model || model_name || "nanobana",
            characters: features ? [{ name: "CHARACTER", description: prompt, traits: features }] : [],
            references,
            project_id: project_id || null,
            session_id: req.body.session_id || req.body.sessionId || null,
        };

        const runResult = await runUseCase({
            useCaseId: "character-sheet-v1",
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
            project_id: project_id,
            session_id: null,
        });

    } catch (err) {
        console.error(`❌ [characterController] createCharacterSheet error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}
