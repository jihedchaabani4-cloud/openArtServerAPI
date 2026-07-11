import { randomUUID } from "node:crypto";
import { db, workflowStorageGateway } from "../src/container.js";

// V2 Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../src/v2/runner/workflowRunner.js";
import { mapElementSheetV1, buildV1CompatibleResponse } from "../src/v2/utils/v1PayloadMapper.js";

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
        } = req.body;

        console.log(`\n🚀 [elementSheetController] ${sheetType} request received`);

        if (!project_id) {
            return res.status(400).json({
                ok:      false,
                message: "project_id is required",
            });
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";
        const v2Payload = mapElementSheetV1(req.body, sheetType);
        
        const runId = randomUUID();
        const v2WorkflowId = v2Payload.workflowId;
        const v2Input = v2Payload.input;

        const registries = getRegistries();
        const workflowDef = registries.workflows[v2WorkflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${v2WorkflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

        // Phase 1 — Pre-create placeholder
        const placeholder = await workflowStorageGateway.createMediaPlaceholder({
            runId,
            nodeType: "image-generation", // Element sheet uses image generator under the hood
            userId,
            workflowId: v2WorkflowId,
            input: v2Input,
        });

        const runtimeInput = {
            ...v2Input,
            userId,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        console.log(`🚀 [elementSheetController] Starting V2 run ${runId}`);
        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        res.json(buildV1CompatibleResponse({
            runId: runResult.run_id,
            v1WorkflowId: placeholder?.workflowId,
            v1MediaId: placeholder?.mediaId,
            projectId: project_id,
            sessionId: null, // no session_id — sheet workflows belong to the project, not a session
        }));

    } catch (err) {
        console.error(`❌ [elementSheetController] Error (${sheetType}):`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

/** POST /api/element-sheet/character */
export const createCharacterSheet = (req, res) =>
    handleSheetRequest(req, res, "CHARACTER");

/** POST /api/element-sheet/location */
export const createLocationSheet = (req, res) =>
    handleSheetRequest(req, res, "LOCATION");

/** POST /api/element-sheet/product */
export const createProductSheet = (req, res) =>
    handleSheetRequest(req, res, "PRODUCT");
