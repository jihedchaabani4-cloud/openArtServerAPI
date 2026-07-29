import { randomUUID } from "node:crypto";
import { db, workflowStorageGateway } from "../src/container.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";

// V2 Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../src/v2/runner/workflowRunner.js";
import { mapUpscaleV1, buildV1CompatibleResponse } from "../src/v2/utils/v1PayloadMapper.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) cachedRegistries = loadRegistries();
    return cachedRegistries;
}

export const upscale = async (req, res) => {
    try {
        const { 
            workflow_id,
        } = req.body;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const userId = req.user.id;

        // Resolve media, project and session from workflow on the server
        const sourceMedia = await db.media.findLatestByWorkflow(workflow_id);
        if (!sourceMedia) {
            return res.status(404).json({ ok: false, message: "No media found for this workflow" });
        }

        const { media_id, project_id, session_id } = sourceMedia;

        // Server-side security: verify media is usable before upscaling
        await assertMediaUsable({
            media_id,
            workflow_id,
            project_id,
            session_id,
        });

        const v2Input = mapUpscaleV1(req.body, sourceMedia);
        const runId = randomUUID();
        const v2WorkflowId = "upscale-v1";

        const registries = getRegistries();
        const workflowDef = registries.workflows[v2WorkflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${v2WorkflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

        // Phase 1 — Pre-create placeholder
        const placeholder = await workflowStorageGateway.createMediaPlaceholder({
            runId,
            nodeType: "media-transform",
            userId,
            workflowId: v2WorkflowId,
            input: v2Input,
        });

        const runtimeInput = {
            ...v2Input,
            userId,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        console.log(`🚀 [UpscaleController] Starting V2 run ${runId}`);
        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        res.json(buildV1CompatibleResponse({
            runId: runResult.run_id,
            v1WorkflowId: placeholder?.workflowId,
            v1MediaId: placeholder?.mediaId,
            projectId: project_id,
            sessionId: session_id,
        }));

    } catch (error) {
        console.error("❌ [UpscaleController] upscale error:", error);
        res.status(error.statusCode || 500).json({ ok: false, message: error.message });
    }
};
