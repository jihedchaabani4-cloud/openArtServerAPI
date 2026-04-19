import express from "express";
import * as imageController      from "../controllers/imageController.js";
import * as editImageController  from "../controllers/editImageController.js";
import { requireAuth }           from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/images/generated — image generation (new workflow) */
router.post("/generatedv2",   requireAuth, imageController.generate);
router.post("/generated", requireAuth, imageController.generateV2);
router.post("/generate",    requireAuth, imageController.generate); // legacy aliasting — edit an existing workflow */
router.post("/generated/edit/existing", requireAuth, editImageController.generateEdit);

/** POST /api/images/generated/edit/new — img2img creating a new workflow */
router.post("/generated/edit/new", requireAuth, imageController.edit);

/** POST /api/images/edit — legacy alias */
router.post("/edit", requireAuth, imageController.edit);
export default router;
