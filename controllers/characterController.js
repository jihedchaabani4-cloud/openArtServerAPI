import { characterService, useCaseService } from "../src/container.js";
import { randomUUID } from "node:crypto";

/**
 * POST /api/characters/create & POST /api/characters
 * 
 * 🌟 Pure HTTP Controller:
 * 1. Saves Character container safely in DB (never loses user work).
 * 2. Prechecks credits for AI Sheet Generation:
 *    - If sufficient: enqueues background UseCase job in Redis.
 *    - If insufficient: returns saved character with needsCredits flag.
 */
export async function createCharacter(req, res) {
    try {
        const {
            project_id,
            projectId,
            name,
            prompt = "",
            references = []
        } = req.body;

        const targetProjectId = project_id || projectId;
        if (!targetProjectId) {
            return res.status(400).json({ ok: false, message: "project_id is required" });
        }

        const userId = req.user.id;
        const charName = name?.trim() || prompt?.slice(0, 40) || "Untitled Character";
        const charPrompt = prompt?.trim() || charName;

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
            project_id: targetProjectId,
            workflow_id: characterId,
            prompt: charPrompt,
            references: Array.isArray(references) ? references : [],
            characters: [{ name: charName, description: charPrompt }],
        };

        // ── 3. Prepare, Reserve Credits & Redis Job Dispatch ─────────────────
        let taskId = null;
        let hasSufficientCredits = true;
        let creditErrorMsg = null;

        try {
            console.log(`💳 [characterController] Preparing character "${characterId}" (UseCase: character-sheet-v1)...`);
            const prepared = await useCaseService.prepareAndEnqueue({
                useCaseId: "character-sheet-v1",
                input: runtimeInput,
                userId,
                executionId: characterId,
                traceId: characterId,
            });
            taskId = prepared.executionId || prepared.workflowRunId || characterId;
            console.log(`📤 [characterController] Prepared and enqueued UseCase job "${prepared.jobId}" for character "${characterId}".`);
        } catch (creditErr) {
            console.warn(`⚠️ [characterController] Prepare/enqueue notice for character ${characterId}:`, creditErr.message);
            hasSufficientCredits = false;
            creditErrorMsg = creditErr.message;
        }

        // ── 4. Return Clean Response ──────────────────────────────────────────
        return res.json({
            ok: true,
            characterId,
            workflowId: characterId,
            taskId,
            status: hasSufficientCredits ? "processing" : "saved",
            needsCredits: !hasSufficientCredits,
            message: hasSufficientCredits
                ? "Character created and sheet generation started."
                : (creditErrorMsg || "Character saved! Add credits to generate the visual sheet."),
            project_id: targetProjectId,
            character: createdResult.character || { id: characterId, name: charName, description: charPrompt, project_id: targetProjectId },
            workflow: { id: characterId, workflow_type: "CHARACTER_SHEET" },
        });

    } catch (err) {
        console.error(`❌ [characterController] createCharacter error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/:characterId/generate-sheet
 * 
 * Dedicated endpoint to generate (or re-generate) a character sheet
 * directly via Redis UseCase worker without re-creating character container.
 */
export async function generateCharacterSheet(req, res) {
    try {
        const { characterId } = req.params;
        const { prompt, references, project_id, projectId } = req.body;
        const userId = req.user.id;

        if (!characterId) {
            return res.status(400).json({ ok: false, message: "characterId is required" });
        }

        // 1. Fetch existing character info from DB
        const wf = await characterService.db.workflows.getWorkflow(characterId).catch(() => null);
        const existingChar = await characterService.db.characters.findByCharacterId(characterId).catch(() => null);

        const targetProjectId = project_id || projectId || wf?.project_id || existingChar?.project_id;
        const charName = existingChar?.name || wf?.display_name || "Untitled Character";
        const effectivePrompt = (prompt && prompt.trim()) || existingChar?.description || existingChar?.character_info || charName;
        const effectiveRefs = Array.isArray(references) ? references : [];

        // 2. If prompt updated, update character row
        if (prompt && prompt.trim() && prompt.trim() !== existingChar?.description) {
            await characterService.updateCharacter({
                characterId,
                updates: { description: prompt.trim(), character_info: prompt.trim() },
                userId,
            }).catch(() => null);
        }

        const runtimeInput = {
            project_id: targetProjectId,
            workflow_id: characterId,
            prompt: effectivePrompt,
            references: effectiveRefs,
            characters: [{ name: charName, description: effectivePrompt }],
        };

        await characterService.db.media.createMedia({
            workflow_id: characterId,
            project_id: targetProjectId,
            step_id: "character_sheet",
            status: "processing",
            url: null,
            width: 1344,
            height: 768,
        }).catch((mediaErr) => {
            console.warn(`⚠️ [characterController] regenerate placeholder notice:`, mediaErr.message);
            return null;
        });

        // 3. Prepare, reserve credits, and enqueue on-demand generation.
        const prepared = await useCaseService.prepareAndEnqueue({
            useCaseId: "character-sheet-v1",
            input: runtimeInput,
            userId,
            executionId: characterId,
            traceId: characterId,
        });

        return res.json({
            ok: true,
            status: "processing",
            characterId,
            workflowId: characterId,
            taskId: prepared.executionId || prepared.workflowRunId || characterId,
            project_id: targetProjectId,
        });
    } catch (err) {
        console.error(`❌ [characterController] generateCharacterSheet error:`, err);
        const statusCode = err.statusCode || (err.code === "INSUFFICIENT_CREDITS" ? 402 : 500);
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

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
