import express from "express";
import * as elementSheetController from "../controllers/elementSheetController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

/**
 * @route POST /api/element-sheet/character
 * @desc Create a structured character generation sheet
 */
router.post("/character", elementSheetController.createCharacterSheet);

export default router;
