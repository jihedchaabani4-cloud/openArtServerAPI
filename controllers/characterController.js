import { characterService, walletService, pricingService } from "../src/container.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";

/**
 * POST /api/characters/create & POST /api/characters
 * 
 * 🌟 Unified 2-in-1 Character Creation Flow:
 * 1. Creates character entity record in Supabase DB (name, description, traits).
 * 2. Automatically dispatches character-sheet-v1 UseCase to generate AI reference sheet.
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

        if (!projectId) {
            return res.status(400).json({ ok: false, message: "project_id is required" });
        }

        const userId = req.user.id;
        const charName = name || title || "Untitled Character";
        const charDesc = description || prompt || "";

        // ── 1. Create Character Profile in DB ─────────────────────────────────
        const createdResult = await characterService.createCharacter({
            projectId,
            userId,
            name: charName,
            description: charDesc,
        });

        // ── 2. Dispatch AI Character Sheet Generation via UseCase ──────────────
        const runtimeInput = {
            prompt: charDesc || charName,
            model: model || model_name || "nanobana",
            characters: [{ name: charName, description: charDesc, traits: traits || {} }],
            references,
            project_id: projectId,
            session_id: req.body.session_id || req.body.sessionId || null,
        };

        const runResult = await runUseCase({
            useCaseId: "character-sheet-v1",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
        });

        // ── 3. Return Unified Response ─────────────────────────────────────────
        res.json({
            ok: true,
            status: "processing",
            character: createdResult.character || { id: createdResult.characterId, name: charName },
            characterId: createdResult.characterId,
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            project_id: projectId,
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
