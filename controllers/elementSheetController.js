import { randomUUID } from "node:crypto";
import { db, workflowStorageGateway } from "../src/container.js";

// V2 Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../src/v2/runner/workflowRunner.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) cachedRegistries = loadRegistries();
    return cachedRegistries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared handler — V2 Engine (character-sheet-v1)
// ─────────────────────────────────────────────────────────────────────────────

async function handleSheetRequest(req, res, sheetType) {
    try {
        const {
            project_id,
            prompt,
            model,
            model_name,
            features,
            references = []
        } = req.body;

        console.log(`\n🚀 [elementSheetController] ${sheetType} request received`);

        if (!project_id) {
            return res.status(400).json({
                ok:      false,
                message: "project_id is required",
            });
        }

        const userId = req.user.id;
        const v2WorkflowId = "character-sheet-v1";
        const v2Input = {
            prompt: prompt || "",
            model: model || model_name || "nanobana",
            characters: features ? [{ name: "CHARACTER", description: prompt, traits: features }] : [],
            references,
            project_id: project_id || null,
            session_id: req.body.session_id || req.body.sessionId || null,
        };
        
        const runId = randomUUID();

        console.log(`\n================================================================`);
        console.log(`🎭 [character-sheet-v1] USE CASE EXECUTING: ${sheetType} SHEET GENERATION`);
        console.log(`📌 Workflow ID: ${v2WorkflowId}`);
        console.log(`📌 Run ID: ${runId}`);
        console.log(`📌 Project ID: ${project_id}`);
        console.log(`📌 User Prompt: "${v2Input.prompt ? v2Input.prompt.slice(0, 120) + '...' : '(No Prompt)'}"`);
        console.log(`📌 Reference Images: ${v2Input.references?.length || 0} attached`);
        console.log(`📌 Character Traits:`, JSON.stringify(v2Input.characters?.[0]?.traits || {}));
        console.log(`================================================================\n`);

        const registries = getRegistries();
        const workflowDef = registries.workflows[v2WorkflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${v2WorkflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

        // Phase 1 — Pre-create placeholder
        const placeholder = await workflowStorageGateway.createMediaPlaceholder({
            runId,
            nodeType: "image-generation",
            userId,
            workflowId: v2WorkflowId,
            input: v2Input,
        });

        const runtimeInput = {
            ...v2Input,
            userId,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        console.log(`🚀 [character-sheet-v1] Starting DAG Execution Plan (Run: ${runId})`);
        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        const v1WfId = placeholder?.workflowId || null;
        const v1MedId = placeholder?.mediaId || null;

        res.json({
            ok: true,
            status: "processing",
            taskId: runResult.run_id,
            jobId: runResult.run_id,
            batchId: null,
            configId: null,
            workflows: v1WfId ? [{ id: v1WfId, primary_media_id: v1MedId }] : [],
            workflow: v1WfId ? { id: v1WfId, primary_media_id: v1MedId } : null,
            v1WorkflowId: v1WfId,
            project_id: project_id,
            session_id: null,
        });

    } catch (err) {
        console.error(`❌ [elementSheetController] Error (${sheetType}):`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

/** POST /api/element-sheet/character */
export const createCharacterSheet = (req, res) =>
    handleSheetRequest(req, res, "CHARACTER");
