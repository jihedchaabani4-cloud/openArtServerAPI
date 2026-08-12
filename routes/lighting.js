import express from "express";
import { randomUUID } from "node:crypto";
import { db, walletService, pricingService } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { requireAuth } from "../src/middleware/auth.js";
import { buildLightingPrompt } from "../src/v2/utils/legacyPromptBuilders.js";

// V2 & UseCase Imports
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { resolveReferences } from "../src/image/utils/resolveReferences.js";

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/lighting/change-lighting
 * Relight an existing image with new lighting parameters via lighting-control-v1 UseCase.
 */
router.post("/change-lighting", async (req, res) => {
    try {
        let {
            angle, elevation, intensity, type, brightness, color,
            project_id, session_id, workflow_id,
            model_name,
            model,
            ratio,
            aspect_ratio,
            quality,
        } = req.body;

        const normalizedModelName = normalizeImageModelName(model || model_name) || "seedream-pro";

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const userId = req.user.id;

        const { project_id: finalProjectId, session_id: finalSessionId } =
            await autoCreateProjectAndSession(userId, project_id, session_id, false);

        const sourceMedia = await db.media.findLatestByWorkflow(workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found." });
        }

        const resolvedReferences = await resolveReferences(db, {
            baseWorkflowId: workflow_id,
        });

        const finalPrompt = buildLightingPrompt({
            angle: angle || 0,
            elevation: elevation || 30,
            intensity: intensity || 50,
            type: type || "soft",
            brightness: brightness || 60,
            color: color || "#ffffff",
        });

        const runtimeInput = {
            prompt: finalPrompt,
            model: normalizedModelName,
            aspect_ratio: aspect_ratio || ratio || "1:1",
            quality: quality || "standard",
            strength: 0.75,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            references: resolvedReferences,
            mode: "image_edit",
            project_id: finalProjectId,
            session_id: finalSessionId,
        };

        const runResult = await runUseCase({
            useCaseId: "lighting-control-v1",
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
        console.error("❌ [ChangeLighting] error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
});

export default router;
