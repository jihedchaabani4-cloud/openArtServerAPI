import express from "express";
import * as characterController from "../controllers/characterController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";
import { createUploadMiddleware } from "../src/middleware/uploadMiddleware.js";
import {
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "../src/platform/media-ingestion/UploadPolicy.js";

const uploadSheet = createUploadMiddleware(CHARACTER_SHEET_UPLOAD_POLICY);
const uploadDetail = createUploadMiddleware(CHARACTER_DETAIL_UPLOAD_POLICY);

const router = express.Router();

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
router.post("/generate-description", rateLimit("characterDescription"), characterController.generateCharacterDescription);

/**
 * @route PATCH /api/characters/:characterId
 * @desc Unified dedicated API to update character fields (name, description, character_info, traits, etc.)
 */
router.patch("/:characterId", characterController.updateCharacter);
router.delete("/:characterId", characterController.deleteCharacter);

/**
 * @route POST /api/characters/:characterId/generate-sheet
 * @desc Generate or re-generate turnaround sheet for an existing character
 */
router.post("/:characterId/generate-sheet", characterController.generateCharacterSheet);

/**
 * @route POST   /api/characters/:characterId/media  — attach a detail image (file upload or mediaId)
 * @route DELETE /api/characters/:characterId/media/:mediaId — remove a detail image
 * @route POST   /api/characters/:characterId/sheet-media — set or replace Body Sheet media (file upload or mediaId)
 * @route POST   /api/characters/:characterId/upload — general character media upload
 */
router.post("/:characterId/media", uploadDetail, characterController.addMediaToCharacter);
router.delete("/:characterId/media/:mediaId", characterController.removeMediaFromCharacter);
router.post("/:characterId/sheet-media", uploadSheet, characterController.setCharacterSheetMedia);
// Sheet and detail share identical middleware-level limits (imageLimit, videoLimit, maxSizeBytes, allowedMimeTypes);
// MediaUploadService.upload() in the domain service applies the exact sheet vs detail UploadPolicy.
router.post("/:characterId/upload", uploadSheet, characterController.uploadCharacterMedia);

export default router;

