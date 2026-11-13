/**
 * System 6: Characters — Public HTTP API Gateway (#characters/api)
 *
 * Exposes character entity CRUD, sheet uploads, detail reference media management,
 * and character description generation.
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 6)
 * - Rule 13: Express isolated strictly to public/api.js
 */

import { Router } from "express";
import * as characterController from "../../../../controllers/characterController.js";
import { requireAuth } from "../../../../src/middleware/auth.js";
import { rateLimit } from "../../../../src/middleware/rateLimit.js";
import { createUploadMiddleware } from "../../../../src/middleware/uploadMiddleware.js";
import {
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "../../../../src/platform/media-ingestion/UploadPolicy.js";

const uploadSheet = createUploadMiddleware(CHARACTER_SHEET_UPLOAD_POLICY);
const uploadDetail = createUploadMiddleware(CHARACTER_DETAIL_UPLOAD_POLICY);

const router = Router();

router.use(requireAuth);

/**
 * @route POST /api/characters/create
 * @route POST /api/characters
 */
router.post("/create", uploadSheet, characterController.createCharacter);
router.post("/", uploadSheet, characterController.createCharacter);
router.post("/character", uploadSheet, characterController.createCharacter);

/**
 * @route POST /api/characters/generate-description
 */
router.post(
    "/generate-description",
    rateLimit("characterDescription"),
    characterController.generateCharacterDescription
);

/**
 * @route PATCH /api/characters/:characterId
 */
router.patch("/:characterId", characterController.updateCharacter);
router.delete("/:characterId", characterController.deleteCharacter);

/**
 * @route POST /api/characters/:characterId/generate-sheet
 */
router.post("/:characterId/generate-sheet", characterController.generateCharacterSheet);

/**
 * @route POST   /api/characters/:characterId/media
 * @route DELETE /api/characters/:characterId/media/:mediaId
 * @route POST   /api/characters/:characterId/sheet-media
 * @route POST   /api/characters/:characterId/upload
 */
router.post("/:characterId/media", uploadDetail, characterController.addMediaToCharacter);
router.delete("/:characterId/media/:mediaId", characterController.removeMediaFromCharacter);
router.post("/:characterId/sheet-media", uploadSheet, characterController.setCharacterSheetMedia);
router.post("/:characterId/upload", uploadSheet, characterController.uploadCharacterMedia);

export { characterController };
export default router;
