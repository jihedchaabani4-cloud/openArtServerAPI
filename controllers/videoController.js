import { randomUUID } from "node:crypto";
import { isVideoModelRegistered } from "../lib/modelRegistryKeys.js";
import { db, workflowStorageGateway, walletService, pricingService } from "../src/container.js";

// V2 & UseCase Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) cachedRegistries = loadRegistries();
    return cachedRegistries;
}

/**
 * Helper to run a V2 video workflow via Use Case Runner and return standard V2 response.
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

    const v1WfId = placeholder?.workflowId || null;
    const v1MedId = placeholder?.mediaId || null;

    const baseResponse = {
        ok: true,
        status: "processing",
        taskId: runResult.executionId,
        jobId: runResult.executionId,
        batchId: null,
        configId: null,
        workflows: v1WfId ? [{ id: v1WfId, primary_media_id: v1MedId }] : [],
        workflow: v1WfId ? { id: v1WfId, primary_media_id: v1MedId } : null,
        v1WorkflowId: v1WfId,
        project_id: projectId,
        session_id: sessionId,
    };

    return {
        ...baseResponse,
        data: baseResponse,
    };
}

/**
 * generateVideo
 * POST /api/video/generated (canonical)
 * POST /api/video/generate  (deprecated alias)
 */
export const generateVideo = async (req, res) => {
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

        const projectId = project_id || req.body.projectId || null;
        const sessionId = session_id || req.body.sessionId || null;

        const v2Input = {
            prompt: prompt.trim(),
            model: activeModel || null,
            aspect_ratio: req.body.aspect_ratio || req.body.ratio || "16:9",
            duration: req.body.duration || "5s",
            negative_prompt: req.body.negative_prompt || req.body.negativePrompt || "",
            references,
            project_id: projectId,
            session_id: sessionId,
        };

        const responseData = await executeV2VideoWorkflow({
            workflowId: "cinematic-video-v1",
            nodeType: "video-generation",
            v2Input,
            userId: req.user.id,
            projectId,
            sessionId,
            req
        });

        res.json(responseData);

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

        const projectId = project_id || req.body.projectId || null;
        const sessionId = session_id || req.body.sessionId || null;

        const v2Input = {
            prompt: req.body.prompt || "",
            model: activeModel || null,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            mode: "video_to_video",
            duration: req.body.duration || "5s",
            references,
            camera_control: req.body.camera_control || null,
            project_id: projectId,
            session_id: sessionId,
        };

        const responseData = await executeV2VideoWorkflow({
            workflowId: "edit-video-v1",
            nodeType: "media-transform",
            v2Input,
            userId: req.user.id,
            projectId,
            sessionId,
            req
        });

        res.json(responseData);

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

        const projectId = project_id || req.body.projectId || null;
        const sessionId = session_id || req.body.sessionId || null;

        const v2Input = {
            prompt: req.body.prompt || "",
            model: activeModel || null,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            mode: "video_to_video",
            duration: req.body.duration || "5s",
            references,
            camera_control: req.body.camera_control || null,
            project_id: projectId,
            session_id: sessionId,
        };

        const responseData = await executeV2VideoWorkflow({
            workflowId: "edit-video-v1",
            nodeType: "media-transform",
            v2Input,
            userId: req.user.id,
            projectId,
            sessionId,
            req
        });

        res.json(responseData);

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

        const combinedReferences = [...references];
        if (video_url) {
            combinedReferences.push({ type: "video", url: video_url, role: "motion_reference" });
        }

        const projectId = project_id || req.body.projectId || null;
        const sessionId = session_id || req.body.sessionId || null;

        const v2Input = {
            prompt: req.body.prompt || "",
            model: activeModel || null,
            source_asset: image_url ? { url: image_url } : null,
            mode: "image_to_video",
            duration: req.body.duration || "5s",
            references: combinedReferences,
            project_id: projectId,
            session_id: sessionId,
        };

        const responseData = await executeV2VideoWorkflow({
            workflowId: "edit-video-v1",
            nodeType: "media-transform",
            v2Input,
            userId: req.user.id,
            projectId,
            sessionId,
            req
        });

        res.json(responseData);

    } catch (error) {
        console.error("❌ [VideoController] motionControl error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
