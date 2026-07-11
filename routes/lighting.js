import express from "express";
import { randomUUID } from "node:crypto";
import { db, workflowStorageGateway } from "../src/container.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";
import { normalizeImageModelName } from "../lib/modelRegistryKeys.js";
import { requireAuth } from "../src/middleware/auth.js";
import { buildLightingPrompt } from "../src/v2/utils/legacyPromptBuilders.js";

// V2 Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../src/v2/runner/workflowRunner.js";
import { buildV1CompatibleResponse, mapEditImageV1 } from "../src/v2/utils/v1PayloadMapper.js";
import { resolveReferences } from "../src/image/utils/resolveReferences.js";

const router = express.Router();
router.use(requireAuth);

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) cachedRegistries = loadRegistries();
    return cachedRegistries;
}

/**
 * POST /api/lighting/change-lighting
 * Relight an existing image with new lighting parameters.
 */
router.post("/change-lighting", async (req, res) => {
    try {
        let {
            angle, elevation, intensity, type, brightness, color,
            project_id, session_id, workflow_id,
            model_name,
            ratio,
            quality,
        } = req.body;

        const normalizedModelName = normalizeImageModelName(model_name) || "seedream-pro";

        console.log("[LightingRoute] body:", req.body);

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

        const payload = {
            prompt: finalPrompt,
            model_name: normalizedModelName,
            references: resolvedReferences,
        };

        const v2Input = mapEditImageV1(payload, sourceMedia);
        
        const runId = randomUUID();
        const v2WorkflowId = "edit-image-v1";
        const registries = getRegistries();
        const workflowDef = registries.workflows[v2WorkflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${v2WorkflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

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

        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        res.json({
            ok: true,
            ...buildV1CompatibleResponse({
                runId: runResult.run_id,
                v1WorkflowId: placeholder?.workflowId,
                v1MediaId: placeholder?.mediaId,
                projectId: finalProjectId,
                sessionId: finalSessionId,
            }),
        });

    } catch (error) {
        console.error("❌ [ChangeLighting] error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
});

export default router;
