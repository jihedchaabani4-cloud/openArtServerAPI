/**
 * System 6: Characters — Public HTTP API Gateway (#characters/api)
 *
 * Sealed Express gateway exposing ONLY charactersRouter (mounted by src/api/routes.js).
 * Exposes character entity CRUD, sheet uploads, detail reference media management,
 * and character description generation.
 *
 * Governed by Rule 13: Express isolated strictly to public/api.js and internal/controllers/.
 */

import { Router } from "express";
import * as characterController from "../internal/controllers/characterController.js";
import { requireAuth, rateLimit } from "#identity/tools";
import { createUploadMiddleware } from "#media/api";
import {
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "#media/tools";

const uploadSheet = createUploadMiddleware(CHARACTER_SHEET_UPLOAD_POLICY);
const uploadDetail = createUploadMiddleware(CHARACTER_DETAIL_UPLOAD_POLICY);

export const charactersRouter = Router();

charactersRouter.use(requireAuth);

/**
 * @route POST /api/characters/create
 * @route POST /api/characters
 */
charactersRouter.post("/create", uploadSheet, characterController.createCharacter);
charactersRouter.post("/", uploadSheet, characterController.createCharacter);
charactersRouter.post("/character", uploadSheet, characterController.createCharacter);

/**
 * @route POST /api/characters/generate-description
 */
charactersRouter.post(
    "/generate-description",
    rateLimit("characterDescription"),
    characterController.generateCharacterDescription
);

/**
 * @route PATCH /api/characters/:characterId
 */
charactersRouter.patch("/:characterId", characterController.updateCharacter);
charactersRouter.delete("/:characterId", characterController.deleteCharacter);

/**
 * @route POST /api/characters/:characterId/generate-sheet
 */
charactersRouter.post("/:characterId/generate-sheet", characterController.generateCharacterSheet);

/**
 * @route POST   /api/characters/:characterId/media
 * @route DELETE /api/characters/:characterId/media/:mediaId
 * @route POST   /api/characters/:characterId/sheet-media
 * @route POST   /api/characters/:characterId/upload
 */
charactersRouter.post("/:characterId/media", uploadDetail, characterController.addMediaToCharacter);
charactersRouter.delete("/:characterId/media/:mediaId", characterController.removeMediaFromCharacter);
charactersRouter.post("/:characterId/sheet-media", uploadSheet, characterController.setCharacterSheetMedia);
charactersRouter.post("/:characterId/upload", uploadSheet, characterController.uploadCharacterMedia);
