import { characterService, walletService, pricingService } from "../src/container.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { randomUUID } from "node:crypto";

/**
 * POST /api/characters/create & POST /api/characters
 * 
 * 🌟 Pure HTTP Controller (Zero logic mutation):
 * 1. Forwards raw character payload directly to Supabase DB.
 * 2. Dispatches character-sheet-v1 UseCase directly to V2 engine queue.
 */
export async function createCharacter(req, res) {
    try {
        const {
            project_id,
            projectId = project_id,
            name,
            title = name,
            prompt = "",
            description = prompt,
            model,
            model_name,
            features,
            traits = features,
            references = []
        } = req.body;

        const targetProjectId = projectId || req.body.project_id || req.body.projectId;

        if (!targetProjectId) {
            return res.status(400).json({ ok: false, message: "project_id is required" });
        }

        const userId = req.user.id;
        const charName = name || title || "Untitled Character";
        const charPrompt = prompt || description || charName;

        // ── 1. Create Character & Single Workflow Container (CHARACTER_SHEET) ──────
        const createdResult = await characterService.createCharacter({
            projectId: targetProjectId,
            userId,
            name: charName,
            description: charPrompt,
        });

        const characterId = createdResult.characterId || createdResult.character?.id || randomUUID();

        // ── 2. Prepare Direct UseCase Runtime Input ───────────────────────────
        const runtimeInput = {
            prompt: charPrompt,
            model: model || model_name || "nanobana",
            characters: [{ name: charName, description: charPrompt, traits, features }],
            references,
            project_id: targetProjectId,
            session_id: null,
            workflow_id: characterId,
        };

        // ── 3. Dispatch AI Character Sheet Generation via UseCase ──────────────
        const runResult = await runUseCase({
            useCaseId: "character-sheet-v1",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
        });

        // ── 4. Return Clean Response ──────────────────────────────────────────
        res.json({
            ok: true,
            status: "processing",
            character: createdResult.character || { id: characterId, name: charName, description: charPrompt, project_id: targetProjectId },
            characterId: characterId,
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            workflows: [{ id: characterId, workflow_type: "CHARACTER_SHEET" }],
            workflow: { id: characterId, workflow_type: "CHARACTER_SHEET" },
            v1WorkflowId: characterId,
            project_id: targetProjectId,
            session_id: null,
        });

    } catch (err) {
        console.error(`❌ [characterController] createCharacter error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * Legacy character sheet alias -> redirects to unified createCharacter
 */
export const createCharacterSheet = createCharacter;

/**
 * POST /api/characters/generate-description
 */
export async function generateCharacterDescription(req, res) {
    try {
        const { concept, archetype, style } = req.body;
        const result = await characterService.generateDescription({ concept, archetype, style });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [characterController] generateCharacterDescription error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * PATCH /api/characters/:characterId
 */
export async function updateCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user.id;
        const result = await characterService.updateCharacter({ characterId, updates: req.body, userId });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [characterController] updateCharacter error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId
 */
export async function deleteCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user.id;
        const result = await characterService.deleteCharacter({ characterId, userId, req });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [characterController] deleteCharacter error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/:characterId/media
 */
export async function addMediaToCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const { mediaId, imageUrl, projectId } = req.body;
        const userId = req.user.id;
        const result = await characterService.addMediaToCharacter({ characterId, mediaId, imageUrl, projectId, userId });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [characterController] addMediaToCharacter error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId/media/:mediaId
 */
export async function removeMediaFromCharacter(req, res) {
    try {
        const { characterId, mediaId } = req.params;
        const userId = req.user.id;
        const result = await characterService.removeMediaFromCharacter({ characterId, mediaId, userId });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error(`❌ [characterController] removeMediaFromCharacter error:`, err);
        res.status(500).json({ ok: false, message: err.message });
    }
}
