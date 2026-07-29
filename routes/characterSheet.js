import express from "express";
import * as characterController from "../controllers/characterController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

/**
 * @route POST /api/character-sheet/character
 * @desc Create a structured character generation sheet (3-view turnaround)
 */
router.post("/character", characterController.createCharacterSheet);

/**
 * @route POST /api/character-sheet/generate-description
 * @desc Generate an ultra-detailed, haute-couture editorial character prompt/description
 */
router.post("/generate-description", characterController.generateCharacterDescription);

export default router;
