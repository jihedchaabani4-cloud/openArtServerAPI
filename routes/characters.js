import express from "express";
import multer from "multer";
import * as characterController from "../controllers/characterController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max file size
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}`));
        }
    },
});

const router = express.Router();

router.use(requireAuth);

/**
 * @route POST /api/characters/create
 * @route POST /api/characters
 */
router.post("/create", upload.single("file"), characterController.createCharacter);
router.post("/", upload.single("file"), characterController.createCharacter);
router.post("/character", upload.single("file"), characterController.createCharacter);

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
router.post("/:characterId/media", upload.single("file"), characterController.addMediaToCharacter);
router.delete("/:characterId/media/:mediaId", characterController.removeMediaFromCharacter);
router.post("/:characterId/sheet-media", upload.single("file"), characterController.setCharacterSheetMedia);
router.post("/:characterId/upload", upload.single("file"), characterController.uploadCharacterMedia);

export default router;

