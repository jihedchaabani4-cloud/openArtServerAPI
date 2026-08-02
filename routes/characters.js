import express from "express";
import * as characterController from "../controllers/characterController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

/**
 * @route POST /api/characters/create
 * @route POST /api/characters
 */
router.post("/create", characterController.createCharacter);
router.post("/", characterController.createCharacter);
router.post("/character", characterController.createCharacter);

/**
 * @route POST /api/characters/generate-description
 */
router.post("/generate-description", characterController.generateCharacterDescription);

/**
 * @route PATCH /api/characters/:characterId
 * @desc Unified dedicated API to update character fields (name, description, character_info, turnaround_url, etc.)
 */
router.patch("/:characterId", characterController.updateCharacter);
router.delete("/:characterId", characterController.deleteCharacter);

/**
 * @route POST   /api/characters/:characterId/media  — attach a detail image
 * @route DELETE /api/characters/:characterId/media/:mediaId — remove a detail image
 */
router.post("/:characterId/media", characterController.addMediaToCharacter);
router.delete("/:characterId/media/:mediaId", characterController.removeMediaFromCharacter);

export default router;

