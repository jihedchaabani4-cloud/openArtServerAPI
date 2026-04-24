import express from "express";
import * as upscaleController from "../controllers/upscaleController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// Unified media endpoints
router.post("/upscale", upscaleController.upscale);

export default router;
