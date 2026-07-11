import express from "express";
import {
  getHealth,
  submitWorkflowRun,
  getWorkflowRunStatus,
} from "../../controllers/v2/workflowsController.js";
import { requireAuth } from "../../src/middleware/auth.js";

const router = express.Router();

// Public health check route
router.get("/health", getHealth);

// Authenticated workflow routes
router.post("/run", requireAuth, submitWorkflowRun);
router.get("/runs/:run_id", requireAuth, getWorkflowRunStatus);

export default router;
