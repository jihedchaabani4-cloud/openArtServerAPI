import { characterService, walletService, pricingService } from "../src/container.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { randomUUID } from "node:crypto";

/**
 * Strips raw template tag wrappers like <Trait: X> or <Tag: Y> into clean natural words.
 */
function stripRawTagSyntax(text = "") {
    if (typeof text !== "string") return "";
    return text
        .replace(/<(?:Trait|Tag|Feature|Attribute):\s*([^>]+)>/gi, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Converts prompt, traits object/array, and features into one clean unified description string.
 */
function buildUnifiedDescription(promptText = "", traitsInput = null, featuresInput = null) {
    const textParts = [];

    const cleanPrompt = stripRawTagSyntax(promptText);
    if (cleanPrompt) {
        textParts.push(cleanPrompt);
    }

    const traitWords = [];
    if (Array.isArray(traitsInput)) {
        traitWords.push(...traitsInput.map(t => stripRawTagSyntax(String(t))));
    } else if (traitsInput && typeof traitsInput === "object") {
        for (const [key, val] of Object.entries(traitsInput)) {
            if (!val) continue;
            const cleanVal = stripRawTagSyntax(String(val));
            const cleanKey = String(key).trim().toLowerCase();
            if (cleanKey === "hair" || cleanKey === "eyes" || cleanKey === "skin") {
                traitWords.push(`${cleanVal} ${cleanKey}`);
            } else if (cleanKey === "outfit" || cleanKey === "clothing") {
                traitWords.push(`wearing ${cleanVal}`);
            } else {
                traitWords.push(cleanVal);
            }
        }
    }

    if (Array.isArray(featuresInput)) {
        traitWords.push(...featuresInput.map(f => stripRawTagSyntax(String(f))));
    }

    const uniqueTraits = Array.from(new Set(traitWords.filter(Boolean)));

    for (const trait of uniqueTraits) {
        if (!textParts.some(p => p.toLowerCase().includes(trait.toLowerCase()))) {
            textParts.push(trait);
        }
    }

    return textParts.join(", ").trim();
}

/**
 * POST /api/characters/create & POST /api/characters
 * 
 * 🌟 Unified Clean Character Creation Flow:
 * 1. Strips raw <Trait: > tag syntax and converts traits/features into a clean description.
 * 2. Creates character entity record in Supabase DB with clean description.
 * 3. Dispatches character-sheet-v1 UseCase to generate AI reference sheet.
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
        const charName = stripRawTagSyntax(name || title || "Untitled Character");
        const charDesc = buildUnifiedDescription(description || prompt || "", traits, features) || charName;

        // ── 1. Create Character & Single Workflow Container (CHARACTER_SHEET) ──────
        const createdResult = await characterService.createCharacter({
            projectId: targetProjectId,
            userId,
            name: charName,
            description: charDesc,
        });

        const characterId = createdResult.characterId || createdResult.character?.id || randomUUID();

        // ── 2. Prepare UseCase Runtime Input ──────────────────────────────────
        const runtimeInput = {
            prompt: charDesc,
            model: model || model_name || "nanobana",
            characters: [{ name: charName, description: charDesc }],
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
            character: createdResult.character || { id: characterId, name: charName, description: charDesc, project_id: targetProjectId },
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
