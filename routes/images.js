import express from "express";
import * as imageController      from "../controllers/imageController.js";
import * as editImageController  from "../controllers/editImageController.js";

const router = express.Router();

/** POST /api/images/generated — image generation (new workflow) */
router.post("/generated",              imageController.generate);

/** POST /api/images/generated/edit/existing — edit an existing workflow */
router.post("/generated/edit/existing", editImageController.generateEdit);

/** POST /api/images/generated/edit/new — img2img creating a new workflow */
router.post("/generated/edit/new",     imageController.edit);

/** POST /api/images/edit — legacy alias */
router.post("/edit", imageController.edit);
export default router;
