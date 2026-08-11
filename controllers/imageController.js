import { randomUUID } from "node:crypto";
import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { db, mediaWorkflowLifecycleService, walletService, pricingService } from "../src/container.js";

// V2 & UseCase Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { mapImageGenerationV1, mapEditImageV1, buildV1CompatibleResponse } from "../src/v2/utils/v1PayloadMapper.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) {
        cachedRegistries = loadRegistries();
    }
    return cachedRegistries;
}

/**
 * generateV2
 * POST /api/images/generated
 * Modern flow delegating to standard Use Case Runner (simple-image-generation)
 */
export const generateV2 = async (req, res) => {
    try {
        console.log(`🚀 [ImageController] generateV2 | Incoming Body:`, JSON.stringify(req.body, null, 2));

        const model_name = normalizeImageModelName(req.body.model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!req.body.prompt) {
            return res.status(400).json({ ok: false, message: "Prompt is required" });
        }

        const userId = req.user.id;
        const v2Input = mapImageGenerationV1(req.body);
        const runId = randomUUID();
        const workflowId = "simple-image-v1";

        const placeholders = await mediaWorkflowLifecycleService.startPlaceholders({
            userId,
            nodeType: "image-generation",
            input: v2Input,
            count: v2Input.count,
            runId,
            workflowId,
        });

        const runtimeInput = {
            ...v2Input,
            _v1PlaceholderIds: placeholders,
        };

        console.log(`🚀 [ImageController] generateV2 | Running Use Case simple-image-generation`);
        const runResult = await runUseCase({
            useCaseId: "simple-image-generation",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
            registries: getRegistries(),
        });

        const firstPh = placeholders[0] || {};
        res.json(buildV1CompatibleResponse({
            runId: runResult.executionId,
            v1WorkflowId: firstPh.workflowId,
            v1MediaId: firstPh.mediaId,
            projectId: req.body.project_id,
            sessionId: req.body.session_id,
        }));

    } catch (error) {
        console.error("❌ [ImageController] generateV2 error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * generateEdit - POST /api/images/generated/edit
 * Specialized for editing an existing workflow.
 * Modern flow using V2 Engine (edit-image-v1)
 */
export const generateEdit = async (req, res) => {
    try {
        if (!req.body.workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const model_name = normalizeImageModelName(req.body.model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const userId = req.user.id;
        const sourceMedia = await db.media.findLatestByWorkflow(req.body.workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found for workflow" });
        }

        const v2Input = mapEditImageV1(req.body, sourceMedia);
        const runId = randomUUID();

        console.log(`🚀 [ImageController] generateEdit | Running Use Case simple-image-fast-v1`);
        const runResult = await runUseCase({
            useCaseId: "simple-image-fast-v1",
            input: v2Input,
            userId,
            walletService,
            pricingService,
            registries: getRegistries(),
        });

        res.json(buildV1CompatibleResponse({
            runId: runResult.executionId,
            projectId: req.body.project_id,
            sessionId: req.body.session_id,
        }));

    } catch (error) {
        console.error("❌ [ImageController] generateEdit error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
