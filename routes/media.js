import express from "express";
import * as upscaleController from "../controllers/upscaleController.js";

const router = express.Router();

// Unified media endpoints
router.post("/upscale", upscaleController.upscale);

export default router;
