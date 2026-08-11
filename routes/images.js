import express from "express";
import * as imageController from "../controllers/imageController.js";
import * as editImageController from "../controllers/editImageController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/images/generated — image generation via V2 UseCaseRunner */
router.post("/generated", requireAuth, imageController.generateV2);

/** POST /api/images/generated/edit/existing — image editing */
router.post("/generated/edit/existing", requireAuth, editImageController.generateEdit);

export default router;
