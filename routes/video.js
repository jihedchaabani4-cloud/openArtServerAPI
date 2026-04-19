import express from "express";
import * as videoController from "../controllers/videoController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/video/generated — video generation */
router.post("/generated", requireAuth, videoController.generateVideo);

/** POST /api/video/extend — video extension */
router.post("/extend", requireAuth, videoController.extendVideo);

/** POST /api/video/edit — video editing */
router.post("/edit", requireAuth, videoController.editVideo);

/** POST /api/video/motion — Motion Control specifically */
router.post("/motion", requireAuth, videoController.motionControl);

/** @deprecated use POST /api/video/generated */
router.post("/generate", videoController.generateVideo);

export default router;
