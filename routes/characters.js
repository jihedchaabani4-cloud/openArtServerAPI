import express from "express";
import multer from "multer";
import * as characterController from "../controllers/characterController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max (images only)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            const err = new Error(`Unsupported file type: ${file.mimetype}`);
            err.statusCode = 415;
            err.code = "UNSUPPORTED_MEDIA_TYPE";
            cb(err);
        }
    },
});

const validateMediaSize = (req, res, next) => {
    if (req.file && req.file.mimetype.startsWith("image/") && req.file.size > 20 * 1024 * 1024) {
        return res.status(413).json({
            ok: false,
            code: "PAYLOAD_TOO_LARGE",
            message: "Image file exceeds maximum allowed size of 20MB",
        });
    }
    next();
};

const router = express.Router();

router.use(requireAuth);

/**
 * @route POST /api/characters/create
 * @route POST /api/characters
 */
router.post("/create", upload.single("file"), validateMediaSize, characterController.createCharacter);
router.post("/", upload.single("file"), validateMediaSize, characterController.createCharacter);
router.post("/character", upload.single("file"), validateMediaSize, characterController.createCharacter);

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
router.post("/:characterId/media", upload.single("file"), validateMediaSize, characterController.addMediaToCharacter);
router.delete("/:characterId/media/:mediaId", characterController.removeMediaFromCharacter);
router.post("/:characterId/sheet-media", upload.single("file"), validateMediaSize, characterController.setCharacterSheetMedia);
router.post("/:characterId/upload", upload.single("file"), validateMediaSize, characterController.uploadCharacterMedia);

export default router;

