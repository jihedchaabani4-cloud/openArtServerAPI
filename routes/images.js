import express from "express";
import * as imageController from "../controllers/imageController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

/** POST /api/images/generated — image generation via V2 UseCaseRunner */
router.post("/generated", requireAuth, imageController.generateImage);

export default router;

