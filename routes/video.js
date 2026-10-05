import express from "express";
import * as videoController from "../controllers/videoController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const router = express.Router();

/** POST /api/video/generated — Video generation via Video UseCase flow */
router.post("/generated", requireAuth, rateLimit("videoGeneration"), videoController.generateVideo);

export default router;
