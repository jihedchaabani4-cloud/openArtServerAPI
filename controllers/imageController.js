import { randomUUID } from "node:crypto";
import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { db, mediaWorkflowLifecycleService, walletService, pricingService } from "../src/container.js";

// V2 & UseCase Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";

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

        const model = normalizeImageModelName(req.body.model || req.body.model_name);
        if (model != null && model !== "" && !isImageModelRegistered(model)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!req.body.prompt) {
            return res.status(400).json({ ok: false, message: "Prompt is required" });
        }

        const userId = req.user.id;
        const count = Number(req.body.count || req.body.num_images || 1);
        const runId = randomUUID();
        const workflowId = "simple-image-v1";
        const projectId = req.body.project_id || req.body.projectId || null;
        const sessionId = req.body.session_id || req.body.sessionId || null;

        const v2Input = {
            prompt: req.body.prompt || "",
            negative_prompt: req.body.negative_prompt || req.body.negativePrompt || "",
            model: model || "fal",
            aspect_ratio: req.body.aspect_ratio || req.body.ratio || "1:1",
            quality: req.body.quality || req.body.resolution || "standard",
            count: isNaN(count) ? 1 : Math.max(1, count),
            references: req.body.references || [],
            project_id: projectId,
            session_id: sessionId,
        };

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
        res.json({
            ok: true,
            status: "processing",
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            batchId: null,
            configId: null,
            workflows: firstPh.workflowId ? [{ id: firstPh.workflowId, primary_media_id: firstPh.mediaId }] : [],
            workflow: firstPh.workflowId ? { id: firstPh.workflowId, primary_media_id: firstPh.mediaId } : null,
            v1WorkflowId: firstPh.workflowId || null,
            project_id: projectId,
            session_id: sessionId,
        });

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

        const model = normalizeImageModelName(req.body.model || req.body.model_name);
        if (model != null && model !== "" && !isImageModelRegistered(model)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const userId = req.user.id;
        const sourceMedia = await db.media.findLatestByWorkflow(req.body.workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found for workflow" });
        }

        const projectId = req.body.project_id || req.body.projectId || null;
        const sessionId = req.body.session_id || req.body.sessionId || null;

        const v2Input = {
            prompt: req.body.prompt || "",
            model: model || null,
            aspect_ratio: req.body.aspect_ratio || req.body.ratio || "1:1",
            quality: req.body.quality || req.body.resolution || "standard",
            strength: req.body.strength ?? 0.75,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            references: req.body.references || [],
            mode: "image_edit",
            project_id: projectId,
            session_id: sessionId,
        };

        console.log(`🚀 [ImageController] generateEdit | Running Use Case simple-image-fast-v1`);
        const runResult = await runUseCase({
            useCaseId: "simple-image-fast-v1",
            input: v2Input,
            userId,
            walletService,
            pricingService,
            registries: getRegistries(),
        });

        res.json({
            ok: true,
            status: "processing",
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            batchId: null,
            configId: null,
            workflows: [],
            workflow: null,
            v1WorkflowId: null,
            project_id: projectId,
            session_id: sessionId,
        });

    } catch (error) {
        console.error("❌ [ImageController] generateEdit error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
