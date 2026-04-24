import express from "express";
import * as generationsQuery from "../controllers/generationsQueryController.js";
import * as projectController from "../controllers/projectController.js";
import * as generationsMutation from "../controllers/generationsMutationController.js";
import * as workflowsController from "../controllers/workflowsController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// ── GET ─────────────────────────────────────────────────────
router.get("/assets/:project_id", generationsQuery.getAssets);

router.get("/project-data/:project_id", projectController.getProjectData);
router.get("/workflow-by-media/:media_id", workflowsController.getWorkflowByMedia);

// Detach a media from its workflow into a brand-new workflow
router.post("/detach-media", workflowsController.detachMediaToNewWorkflow);


// ── PATCH (Update) ──────────────────────────────────────────
router.patch("/workflows/:id", workflowsController.patchWorkflow);
router.patch("/workflows/:id/move", workflowsController.moveWorkflow);
router.patch("/workflows/:id/like", workflowsController.toggleLike);
router.patch("/workflows/:id/primary-media", workflowsController.setPrimaryMedia);
router.patch("/items/:id/like", generationsMutation.toggleLike);

// ── DELETE ──────────────────────────────────────────────────
router.delete("/workflows/:id", workflowsController.deleteWorkflow);
router.delete("/:id", workflowsController.deleteWorkflow);
router.delete("/items/:id", generationsMutation.deleteItem);
router.delete("/media/:media_id", workflowsController.deleteMedia);

export default router;
