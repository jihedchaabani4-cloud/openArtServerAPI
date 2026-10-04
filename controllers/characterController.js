import { characterService } from "../src/container.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const controllerLogger = createLogger("controller");

/**
 * POST /api/characters/create & POST /api/characters
 * Creates character entity and either saves uploaded image or initiates AI sheet generation.
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
        const file = req.file;
        const imageUrl = req.body?.imageUrl;

        const result = await characterService.createCharacter({
            projectId: targetProjectId,
            userId,
            name,
            prompt,
            references,
            file,
            imageUrl,
        });

        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ err }, `createCharacter error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/:characterId/generate-sheet
 * Regenerates the 3-view turnaround sheet for an existing character.
 */
export async function generateCharacterSheet(req, res) {
    try {
        const { characterId } = req.params;
        const { prompt, references, project_id, projectId } = req.body;
        const userId = req.user.id;

        if (!characterId) {
            return res.status(400).json({ ok: false, message: "characterId is required" });
        }

        const result = await characterService.generateCharacterSheet({
            characterId,
            prompt,
            references,
            projectId: project_id || projectId,
            userId,
        });

        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, err }, `generateCharacterSheet error: ${err.message}`);
        const statusCode = err.statusCode || (err.code === "INSUFFICIENT_CREDITS" ? 402 : 500);
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/generate-description
 * Generates an evocative character prompt using the AI Art Director.
 */
export async function generateCharacterDescription(req, res) {
    try {
        const { concept, archetype, style } = req.body;
        const userId = req.user?.id;
        const result = await characterService.generateDescription({ concept, archetype, style, userId });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ err }, `generateCharacterDescription error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        const isServerFault = statusCode >= 500 || err.category === "SERVER_FAULT";
        const clientCode = isServerFault ? "INTERNAL_ERROR" : (err.code || "REQUEST_ERROR");
        const clientMessage = isServerFault
            ? "An unexpected error occurred. Please try again later."
            : err.message;
        const traceId = req.headers["x-trace-id"] || req.headers["traceparent"] || undefined;
        return res.status(statusCode).json({
            ok: false,
            error: true,
            code: clientCode,
            category: err.category || (isServerFault ? "SERVER_FAULT" : "USER_FAULT"),
            message: clientMessage,
            ...(traceId ? { traceId } : {}),
        });
    }
}

/**
 * PATCH /api/characters/:characterId
 * Dedicated API to update character fields (name, description, character_info, traits, etc.)
 */
export async function updateCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user.id;
        const result = await characterService.updateCharacter({ characterId, updates: req.body, userId });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, err }, `updateCharacter error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId
 * Permanently removes character workflow, character entity, and associated media.
 */
export async function deleteCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user.id;
        const result = await characterService.deleteCharacter({ characterId, userId, req });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, err }, `deleteCharacter error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/:characterId/media
 * Attaches a detail reference image to character (multipart file, dataUrl, or mediaId).
 */
export async function addMediaToCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const { mediaId, imageUrl } = req.body || {};
        const projectId = req.body?.projectId || req.body?.project_id || req.query?.projectId || req.query?.project_id;
        const userId = req.user.id;
        const file = req.file;

        const result = await characterService.addMediaToCharacter({
            characterId,
            mediaId,
            imageUrl,
            file,
            projectId,
            userId,
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, err }, `addMediaToCharacter error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId/media/:mediaId
 * Removes a detail reference image from character.
 */
export async function removeMediaFromCharacter(req, res) {
    try {
        const { characterId, mediaId: paramMediaId } = req.params;
        const mediaId = paramMediaId || req.body?.mediaId;
        const userId = req.user.id;
        const result = await characterService.removeMediaFromCharacter({ characterId, mediaId, userId });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, mediaId: req.params?.mediaId, err }, `removeMediaFromCharacter error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/:characterId/sheet-media
 * Sets or replaces turnaround body sheet media (multipart file, dataUrl, or mediaId).
 */
export async function setCharacterSheetMedia(req, res) {
    try {
        const { characterId } = req.params;
        const { mediaId, imageUrl } = req.body || {};
        const projectId = req.body?.projectId || req.body?.project_id || req.query?.projectId || req.query?.project_id;
        const userId = req.user.id;
        const file = req.file;

        const result = await characterService.setCharacterSheetMedia({
            characterId,
            mediaId,
            imageUrl,
            file,
            projectId,
            userId,
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, err }, `setCharacterSheetMedia error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}

/**
 * POST /api/characters/:characterId/upload
 * Unified upload endpoint for character media (sheet or detail).
 */
export async function uploadCharacterMedia(req, res) {
    try {
        const { characterId } = req.params;
        const type = req.body?.type || req.query?.type || "sheet";
        const projectId = req.body?.projectId || req.body?.project_id || req.query?.projectId || req.query?.project_id;
        const userId = req.user.id;
        const file = req.file;
        const imageUrl = req.body?.imageUrl;
        const mediaId = req.body?.mediaId;

        const result = type === "detail"
            ? await characterService.addMediaToCharacter({ characterId, mediaId, imageUrl, file, projectId, userId })
            : await characterService.setCharacterSheetMedia({ characterId, mediaId, imageUrl, file, projectId, userId });

        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ characterId: req.params?.characterId, err }, `uploadCharacterMedia error: ${err.message}`);
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).json({ ok: false, message: err.message });
    }
}
