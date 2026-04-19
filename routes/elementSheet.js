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

/**
 * @route POST /api/element-sheet/location
 * @desc Create a structured location generation sheet
 */
router.post("/location", elementSheetController.createLocationSheet);

/**
 * @route POST /api/element-sheet/product
 * @desc Create a structured product generation sheet
 */
router.post("/product", elementSheetController.createProductSheet);

export default router;
