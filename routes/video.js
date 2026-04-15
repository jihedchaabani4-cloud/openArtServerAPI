import express from "express";
import * as videoController from "../controllers/videoController.js";

const router = express.Router();

/** POST /api/video/generated — video generation */
router.post("/generated", videoController.generateVideo);

/** POST /api/video/extend — video extension */
router.post("/extend", videoController.extendVideo);

/** POST /api/video/edit — video editing */
router.post("/edit", videoController.editVideo);

/** @deprecated use POST /api/video/generated */
router.post("/generate", videoController.generateVideo);

export default router;
