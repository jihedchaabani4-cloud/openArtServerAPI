import { randomUUID } from "node:crypto";
import { workflowStorageGateway, characterService, mediaWorkflowLifecycleService } from "../src/container.js";

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
// Character Controller — V2 Engine (character-sheet-v1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/characters/create
 * Creates a new 3-view character workflow with LLM prompt enrichment.
 */
export async function createCharacter(req, res) {
    try {
        const { project_id } = req.body;

        console.log(`\n🚀 [characterController] CREATE CHARACTER request received`);

        if (!project_id) {
            return res.status(400).json({
                ok:      false,
                message: "project_id is required",
            });
        }

        const userId = req.user.id;
        const runId = randomUUID();
        const v2WorkflowId = "character-sheet-v1";
        const v2Input = req.body;

        console.log(`\n================================================================`);
        console.log(`🎭 [character-sheet-v1] USE CASE EXECUTING: CHARACTER SHEET GENERATION`);
        console.log(`📌 Workflow ID: ${v2WorkflowId}`);
        console.log(`📌 Run ID: ${runId}`);
        console.log(`📌 Project ID: ${project_id}`);
        console.log(`📌 User Prompt: "${v2Input.prompt ? v2Input.prompt.slice(0, 120) + '...' : '(No Prompt)'}"`);
        console.log(`📌 Reference Images: ${v2Input.references?.length || 0} attached`);
        console.log(`================================================================\n`);

        const registries = getRegistries();
        const workflowDef = registries.workflows[v2WorkflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${v2WorkflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

        // Phase 1 — Explicit domain placeholder creation
        const placeholder = await mediaWorkflowLifecycleService.createCharacterPlaceholder({
            userId,
            input: v2Input,
            runId,
            displayName: v2Input.name || v2Input.title || v2Input.prompt,
        });

        const runtimeInput = {
            ...v2Input,
            userId,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        console.log(`🚀 [character-sheet-v1] Starting DAG Execution Plan (Run: ${runId})`);
        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        // Record character domain metadata via CharacterService
        if (placeholder?.workflowId) {
            await characterService.createCharacter({
                projectId: project_id,
                userId,
                workflowId: placeholder.workflowId,
                name: v2Input.name || v2Input.title || v2Input.prompt,
                description: v2Input.description || v2Input.character_info,
            }).catch(err => console.warn(`⚠️ [characterController] Character metadata sync warning:`, err.message));
        }

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
        console.error(`❌ [characterController] createCharacterSheet error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

// ─── Character Description Generator ─────────────────────────────────────────

/**
 * POST /api/character-sheet/generate-description
 * Generates an ultra-detailed, haute-couture editorial character prompt/description from a short brief or archetype.
 * Delegates fully to CharacterService.generateDescription() — no LLM calls or system prompts in the controller.
 */
export async function generateCharacterDescription(req, res) {
    try {
        const { concept, archetype, style } = req.body;

        const result = await characterService.generateDescription({ concept, archetype, style });

        return res.json({ success: true, ...result });
    } catch (err) {
        console.error("❌ [characterController] generateCharacterDescription error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

export const createCharacterSheet = createCharacter;

// ─── Add Media to Character ───────────────────────────────────────────────────

/**
 * POST /api/characters/:characterId/media
 * Attaches 1-5 user-supplied detail images to an existing character workflow.
 */
export async function addMediaToCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const { mediaId: inputMediaId, media_id, imageUrl, projectId } = req.body;
        const userId = req.user.id;
        const targetMediaId = inputMediaId || media_id;

        const result = await characterService.addMediaToCharacter({
            characterId,
            mediaId: targetMediaId,
            imageUrl,
            projectId,
            userId,
        });

        return res.json({ ok: true, media: result.media });
    } catch (err) {
        console.error("[characterController] addMediaToCharacter error:", err);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId/media/:mediaId
 * Removes a detail image from the character.
 */
export async function removeMediaFromCharacter(req, res) {
    try {
        const { characterId, mediaId } = req.params;
        const userId = req.user.id;

        const result = await characterService.removeMediaFromCharacter({
            characterId,
            mediaId,
            userId,
        });

        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error("[characterController] removeMediaFromCharacter error:", err);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
}

/**
 * PATCH /api/characters/:characterId
 * Unified dedicated API endpoint to update any field of a Character.
 * Delegates to CharacterService.
 */
export async function updateCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user?.id;
        const body = req.body || {};

        const result = await characterService.updateCharacter({
            characterId,
            updates: body,
            userId,
        });

        return res.json({
            ok: true,
            character: result.character,
            workflow: result.workflow,
        });

    } catch (err) {
        console.error(`❌ [characterController] updateCharacter error:`, err);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId
 * Removes character entity and delegates workflow/media cleanup to CharacterService -> WorkflowLifecycleService.
 */
export async function deleteCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user?.id;

        const result = await characterService.deleteCharacter({ characterId, userId, req });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [characterController] deleteCharacter error:`, err);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
}
