import { randomUUID } from "node:crypto";
import { normalizeImageModelName, isImageModelRegistered } from "../lib/modelRegistryKeys.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";
import { db, workflowStorageGateway } from "../src/container.js";

// V2 Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../src/v2/runner/workflowRunner.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) {
        cachedRegistries = loadRegistries();
    }
    return cachedRegistries;
}

/**
 * POST /api/images/generated/edit/existing
 *
 * Edits an existing workflow by generating a new media item and attaching it.
 * Modern flow using V2 Engine (edit-image-v1)
 */
export const generateEdit = async (req, res) => {
    try {
        if (!req.body.workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }
        if (!req.body.prompt) {
            return res.status(400).json({ ok: false, message: "prompt is required" });
        }

        const model_name = normalizeImageModelName(req.body.model || req.body.model_name);
        if (model_name != null && model_name !== "" && !isImageModelRegistered(model_name)) {
            return res.status(400).json({ ok: false, message: `Model "${model_name}" not found` });
        }

        const userId = req.user.id;
        const finalProjectId = req.body.project_id || req.body.projectId || null;
        const finalSessionId = req.body.session_id || req.body.sessionId || null;

        // Server-side security: edits require a completed source media
        await assertMediaUsable({
            workflow_id: req.body.workflow_id,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

        const sourceMedia = await db.media.findLatestByWorkflow(req.body.workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "Source media not found for workflow" });
        }

        const v2Input = {
            prompt: req.body.prompt || "",
            model: model_name || null,
            aspect_ratio: req.body.aspect_ratio || req.body.ratio || "1:1",
            quality: req.body.quality || req.body.resolution || "standard",
            strength: req.body.strength ?? 0.75,
            source_asset: sourceMedia ? { url: sourceMedia.url, width: sourceMedia.width, height: sourceMedia.height } : null,
            references: req.body.references || [],
            mode: "image_edit",
            project_id: finalProjectId,
            session_id: finalSessionId,
        };

        const runId = randomUUID();
        const workflowId = "edit-image-v1";

        const registries = getRegistries();
        const workflowDef = registries.workflows[workflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${workflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

        // Phase 1 — Pre-create placeholder
        const placeholder = await workflowStorageGateway.createMediaPlaceholder({
            runId,
            nodeType: "media-transform",
            userId,
            workflowId,
            input: v2Input,
        });

        const runtimeInput = {
            ...v2Input,
            userId,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        console.log(`🚀 [EditImageController] generateEdit | Starting V2 run ${runId}`);
        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        const v1WfId = placeholder?.workflowId || null;
        const v1MedId = placeholder?.mediaId || null;

        return res.json({
            ok: true,
            status: "processing",
            taskId: runResult.run_id,
            jobId: runResult.run_id,
            batchId: null,
            configId: null,
            workflows: v1WfId ? [{ id: v1WfId, primary_media_id: v1MedId }] : [],
            workflow: v1WfId ? { id: v1WfId, primary_media_id: v1MedId } : null,
            v1WorkflowId: v1WfId,
            project_id: finalProjectId,
            session_id: finalSessionId,
        });

    } catch (error) {
        console.error("❌ [EditImageController] Error:", error);
        return res.status(error.statusCode || 500).json({ ok: false, message: error.message });
    }
};
