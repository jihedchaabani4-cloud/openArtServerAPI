import express from "express";
import * as imageController from "../controllers/imageController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const router = express.Router();

/** POST /api/images/generated — Image generation via Image UseCase flow */
router.post("/generated", requireAuth, rateLimit("imageGeneration"), imageController.generateImage);

export default router;

