import express from "express";
import * as trashController from "../controllers/trashController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/", trashController.listTrash);
router.post("/:workflowId/restore", trashController.restoreWorkflow);

export default router;
