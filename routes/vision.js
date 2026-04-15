import express from "express";
import * as visionController from "../controllers/visionController.js";

const router = express.Router();

/**
 * @route   POST /api/vision/analyze
 * @desc    Analyze an image and return description
 * @access  Public
 */
router.post("/analyze", visionController.analyzeImage);

/**
 * @route   POST /api/vision/extract-prompt
 * @desc    Extract a generator-friendly prompt from an image
 * @access  Public
 */
router.post("/extract-prompt", visionController.extractPrompt);

/**
 * @route   POST /api/vision/whats-next
 * @desc    Analyze image and generate creative variations
 * @access  Public
 */
router.post("/whats-next", visionController.whatsNext);

export default router;
