import { characterService, walletService, pricingService, workflowStorageGateway } from "../src/container.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { randomUUID } from "node:crypto";

/**
 * POST /api/characters/create & POST /api/characters
 * 
 * 🌟 Unified 2-in-1 Character Creation Flow:
 * 1. Creates character entity record in Supabase DB (project-level asset).
 * 2. Creates workflow container & media placeholders (status='processing').
 * 3. Automatically dispatches character-sheet-v1 UseCase to generate AI reference sheet.
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
        const charDesc = description || prompt || "";

        // ── 1. Save Character Profile Entity in DB (Project-level Asset) ──────
        const createdResult = await characterService.createCharacter({
            projectId: targetProjectId,
            userId,
            name: charName,
            description: charDesc,
        });

        const characterId = createdResult.characterId || createdResult.character?.id || randomUUID();
        const runId = randomUUID();

        // ── 2. Create Workflow Container & Media Placeholder (status='processing')
        const v2Input = {
            prompt: charDesc || charName,
            model: model || model_name || "nanobana",
            characters: [{ name: charName, description: charDesc, traits: traits || {} }],
            references,
            project_id: targetProjectId,
            session_id: null, // Characters belong to project, not a canvas session
        };

        const placeholder = await workflowStorageGateway.createMediaPlaceholder({
            runId,
            nodeType: "image-generation",
            userId,
            workflowId: characterId,
            input: v2Input,
        }).catch((err) => {
            console.warn("⚠️ [characterController] Placeholder creation notice:", err.message);
            return null;
        });

        // ── 3. Dispatch AI Character Sheet Generation via UseCase ──────────────
        const runtimeInput = {
            ...v2Input,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        const runResult = await runUseCase({
            useCaseId: "character-sheet-v1",
            input: runtimeInput,
            userId,
            walletService,
            pricingService,
        });

        // ── 4. Return Full Unified Response ────────────────────────────────────
        const v1WfId = placeholder?.workflowId || characterId;
        const v1MedId = placeholder?.mediaId || null;

        res.json({
            ok: true,
            status: "processing",
            character: createdResult.character || { id: characterId, name: charName, project_id: targetProjectId },
            characterId: characterId,
            taskId: runResult.executionId,
            jobId: runResult.executionId,
            workflows: v1WfId ? [{ id: v1WfId, primary_media_id: v1MedId }] : [],
            workflow: v1WfId ? { id: v1WfId, primary_media_id: v1MedId } : null,
            v1WorkflowId: v1WfId,
            v1MediaId: v1MedId,
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
