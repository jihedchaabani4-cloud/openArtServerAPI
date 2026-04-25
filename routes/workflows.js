import express from "express";
import * as generationsQuery from "../controllers/generationsQueryController.js";
import * as projectController from "../controllers/projectController.js";
import * as generationsMutation from "../controllers/generationsMutationController.js";
import * as workflowsController from "../controllers/workflowsController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/library", generationsQuery.getUserLibrary);
router.get("/library/:workflow_id", generationsQuery.getLibraryWorkflowDetail);
router.get("/assets/:project_id", generationsQuery.getAssets);
router.get("/project-data/:project_id", projectController.getProjectData);
router.get("/workflow-by-media/:media_id", workflowsController.getWorkflowByMedia);

router.post("/detach-media", workflowsController.detachMediaToNewWorkflow);

router.patch("/workflows/like", workflowsController.bulkToggleLike);
router.delete("/workflows", workflowsController.bulkDeleteWorkflows);
router.patch("/workflows/:id", workflowsController.patchWorkflow);
router.patch("/workflows/:id/move", workflowsController.moveWorkflow);
router.patch("/workflows/:id/like", workflowsController.toggleLike);
router.patch("/workflows/:id/primary-media", workflowsController.setPrimaryMedia);
router.patch("/items/:id/like", generationsMutation.toggleLike);

router.delete("/workflows/:id", workflowsController.deleteWorkflow);
router.delete("/:id", workflowsController.deleteWorkflow);
router.delete("/items/:id", generationsMutation.deleteItem);
router.delete("/media/:media_id", workflowsController.deleteMedia);

export default router;
