import express from "express";
import { requireAuth } from "../src/middleware/auth.js";
import { getWorkflowStatus, startWorkflow } from "../controllers/workflowArchitectureController.js";

const router = express.Router();

router.use(requireAuth);
router.post("/", startWorkflow);
router.get("/:executionId", getWorkflowStatus);

export default router;
