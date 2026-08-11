import { randomUUID } from "node:crypto";
import { isVideoModelRegistered } from "../lib/modelRegistryKeys.js";
import { findMigrationInventoryItem, LEGACY_PATH_STATUSES } from "../src/registry/migrationInventory.js";
import { startWorkflow } from "./workflowArchitectureController.js";
import { db, workflowStorageGateway, walletService, pricingService } from "../src/container.js";

// V2 & UseCase Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { 
    mapVideoGenerationV1, 
    mapEditVideoV1, 
    mapMotionControlV1, 
    buildV1CompatibleResponse 
} from "../src/v2/utils/v1PayloadMapper.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) cachedRegistries = loadRegistries();
    return cachedRegistries;
}

/**
 * Helper to run a V2 video workflow via Use Case Runner and return the V1-compatible response.
 */
async function executeV2VideoWorkflow({ 
    workflowId, nodeType, v2Input, userId, projectId, sessionId, req 
}) {
    const runId = randomUUID();

    // Phase 1 — Pre-create placeholder
    const placeholder = await workflowStorageGateway.createMediaPlaceholder({
        runId,
        nodeType,
        userId,
        workflowId,
        input: v2Input,
    });

    const runtimeInput = {
        ...v2Input,
        _v1PlaceholderIds: placeholder ? [placeholder] : [],
    };

    console.log(`🚀 [VideoController] Running Use Case simple-video-generation for run ${runId}`);
    const runResult = await runUseCase({
        useCaseId: "simple-video-generation",
        input: runtimeInput,
        userId,
        walletService,
        pricingService,
        registries: getRegistries(),
    });

    return buildV1CompatibleResponse({
        runId: runResult.executionId,
        v1WorkflowId: placeholder?.workflowId,
        v1MediaId: placeholder?.mediaId,
        projectId,
        sessionId,
    });
}

/**
 * generateVideo
 * POST /api/video/generated (canonical)
 * POST /api/video/generate  (deprecated alias)
 */
export const generateVideo = async (req, res) => {
    const item = findMigrationInventoryItem("video-generation");
    const forceRollback = req.headers["x-force-rollback"] === "true" || req.query?.rollback === "true";
    if (forceRollback && item && item.legacyPathStatus === LEGACY_PATH_STATUSES.ROLLBACK_WINDOW) {
        console.warn("⚠️ [VideoController] Rolling back to legacy video-generation path (active rollback window)");
        req.body = req.body || {};
        req.body.featureId = "video-generation";
        return startWorkflow(req, res);
    }

    try {
        const { model, model_name, prompt, references = [], project_id, session_id } = req.body;
        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        if (!prompt?.trim()) {
            return res.status(400).json({ ok: false, message: "prompt is required" });
        }

        const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
        if (hasBase64) {
            return res.status(400).json({
                ok: false,
                message: "Base64 references are not accepted. Please upload the asset first via POST /api/assets/upload and use the returned URL or asset_id."
            });
        }

        console.log(`\n📥 [VideoController] generate request received: Model: ${activeModel ?? "(default)"}, Prompt: "${prompt}"`);

        const v2Input = mapVideoGenerationV1(req.body);
        const responseData = await executeV2VideoWorkflow({
            workflowId: "cinematic-video-v1",
            nodeType: "video-generation",
            v2Input,
            userId: req.user.id,
            projectId: project_id,
            sessionId: session_id,
            req
        });

        res.json({
            ...responseData,
            data: responseData, // keeping nested for backward compat
        });

    } catch (error) {
        console.error("❌ [VideoController] generateVideo error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * extendVideo
 * POST /api/video/extend
 */
export const extendVideo = async (req, res) => {
    try {
        const { model, model_name, workflow_id, video_workflow_id, media_id, project_id, session_id } = req.body;
        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const finalWfId = video_workflow_id || workflow_id;
        if (!finalWfId || !media_id) {
            return res.status(400).json({ ok: false, message: "video_workflow_id and media_id are required to extend a video." });
        }

        const references = req.body.references || [];
        const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
        if (hasBase64) {
            return res.status(400).json({ ok: false, message: "Base64 references are not accepted." });
        }

        const sourceMedia = await db.media.findLatestByWorkflow(finalWfId);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found for workflow" });
        }

        const v2Input = mapEditVideoV1(req.body, sourceMedia);
        const responseData = await executeV2VideoWorkflow({
            workflowId: "edit-video-v1",
            nodeType: "media-transform",
            v2Input,
            userId: req.user.id,
            projectId: project_id,
            sessionId: session_id,
            req
        });

        res.json({
            ...responseData,
            data: responseData,
        });

    } catch (error) {
        console.error("❌ [VideoController] extendVideo error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * editVideo
 * POST /api/video/edit
 */
export const editVideo = async (req, res) => {
    try {
        const { model, model_name, workflow_id, video_workflow_id, project_id, session_id } = req.body;
        const rawModel = (model ?? model_name ?? "").trim();
        const activeModel = rawModel || undefined;

        if (activeModel != null && activeModel !== "" && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        const finalWfId = video_workflow_id || workflow_id;
        if (!finalWfId) {
            return res.status(400).json({ ok: false, message: "video_workflow_id is required to edit a video." });
        }

        const references = req.body.references || [];
        const hasBase64 = references.some(r => typeof r.url === 'string' && r.url.startsWith('data:'));
        if (hasBase64) {
            return res.status(400).json({ ok: false, message: "Base64 references are not accepted." });
        }

        const sourceMedia = await db.media.findLatestByWorkflow(finalWfId);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found for workflow" });
        }

        const v2Input = mapEditVideoV1(req.body, sourceMedia);
        const responseData = await executeV2VideoWorkflow({
            workflowId: "edit-video-v1",
            nodeType: "media-transform",
            v2Input,
            userId: req.user.id,
            projectId: project_id,
            sessionId: session_id,
            req
        });

        res.json({
            ...responseData,
            data: responseData,
        });

    } catch (error) {
        console.error("❌ [VideoController] editVideo error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * motionControl
 * POST /api/video/motion
 */
export const motionControl = async (req, res) => {
    try {
        const {
            model,
            image_workflow_id,
            video_workflow_id,
            references = [],
            project_id,
            session_id,
        } = req.body;

        const activeModel = (model || "").trim() || undefined;
        if (activeModel && !isVideoModelRegistered(activeModel)) {
            return res.status(400).json({ ok: false, message: "Model not found" });
        }

        let image_url = req.body.image_url;
        let video_url = req.body.video_url;

        // Extract from references array
        if (!image_url && references?.length) {
            const img = references.find(r => r.role === 'mc_image' || r.type === 'image');
            if (img) image_url = img.url;
        }
        if (!video_url && references?.length) {
            const vid = references.find(r => r.role === 'mc_video' || r.type === 'video');
            if (vid) video_url = vid.url;
        }

        // Fallback to workflow IDs
        if (!image_url && image_workflow_id) {
            const media = await db.media.findLatestByWorkflow(image_workflow_id);
            image_url = media?.url;
        }
        if (!video_url && video_workflow_id) {
            const media = await db.media.findLatestByWorkflow(video_workflow_id);
            video_url = media?.url;
        }

        if (!image_url || !video_url) {
            return res.status(400).json({ 
                ok: false, 
                message: "Motion Control requires both an image reference and a video reference." 
            });
        }

        const v2Input = mapMotionControlV1(req.body, image_url, video_url);
        const responseData = await executeV2VideoWorkflow({
            workflowId: "edit-video-v1",
            nodeType: "media-transform",
            v2Input,
            userId: req.user.id,
            projectId: project_id,
            sessionId: session_id,
            req
        });

        res.json({
            ...responseData,
            data: responseData,
        });

    } catch (error) {
        console.error("❌ [VideoController] motionControl error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
