import express from "express";
import * as imageController      from "../controllers/imageController.js";
import * as editImageController  from "../controllers/editImageController.js";
import { requireAuth }           from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/images/generated — image generation (new workflow) */
router.post("/generated", requireAuth, imageController.generateV2);
router.post("/generated/edit/existing", requireAuth, editImageController.generateEdit);

export default router;
