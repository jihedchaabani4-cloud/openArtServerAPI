/**
 * System 1: Generation & Workflows — Public API Gateway (#generation/api)
 *
 * Exposes Express HTTP routes for image generation, video generation,
 * prompt optimization, V2 workflows, and legacy workflow endpoints.
 * Isolates express web framework strictly to public/api.js per Rule 13.
 */

import express from "express";
import { Router } from "express";

import * as imageController from "../internal/controllers/imageController.js";
import * as videoController from "../internal/controllers/videoController.js";
import * as generationsQuery from "../internal/controllers/generationsQueryController.js";
import * as projectController from "../internal/controllers/projectController.js";
import * as generationsMutation from "../internal/controllers/generationsMutationController.js";
import * as workflowsController from "../internal/controllers/workflowsController.js";

import { requireAuth, rateLimit } from "#identity/tools";

// ── Images Router ──────────────────────────────────────────────────
export const imagesRouter = express.Router();
imagesRouter.post("/generated", requireAuth, rateLimit("imageGeneration"), imageController.generateImage);
imagesRouter.post("/relight", requireAuth, rateLimit("imageGeneration"), imageController.relightImage);
imagesRouter.post("/angles", requireAuth, rateLimit("imageGeneration"), imageController.changeImageAngle);
imagesRouter.post("/remove-background", requireAuth, rateLimit("imageGeneration"), imageController.removeImageBackground);
imagesRouter.post("/edit", requireAuth, rateLimit("imageGeneration"), imageController.editImage);

// ── Video Router ───────────────────────────────────────────────────
export const videoRouter = express.Router();
videoRouter.post("/generated", requireAuth, rateLimit("videoGeneration"), videoController.generateVideo);

// ── Prompt Router ──────────────────────────────────────────────────
export const promptRouter = Router();
promptRouter.post("/optimize", requireAuth, rateLimit("promptOptimization"), workflowsController.optimizePrompt);

// ── Workflows Run Inspection Router ────────────────────────────────
export const v2WorkflowsRouter = express.Router();
v2WorkflowsRouter.get("/health", workflowsController.getWorkflowHealth);
v2WorkflowsRouter.post("/run", requireAuth, workflowsController.runWorkflowDisabled);

// ── Workflows Router (V1 CRUD & Library) ───────────────────────────
export const workflowsRouter = express.Router();
workflowsRouter.use(requireAuth);

workflowsRouter.get("/library", generationsQuery.getUserLibrary);
workflowsRouter.get("/library/:workflow_id", generationsQuery.getLibraryWorkflowDetail);
workflowsRouter.get("/assets/:project_id", generationsQuery.getAssets);
workflowsRouter.get("/project-data/:project_id", projectController.getProjectData);
workflowsRouter.get("/workflow-by-media/:media_id", workflowsController.getWorkflowByMedia);

workflowsRouter.post("/detach-media", workflowsController.detachMediaToNewWorkflow);

workflowsRouter.patch("/workflows/like", workflowsController.bulkToggleLike);
workflowsRouter.delete("/workflows", workflowsController.bulkDeleteWorkflows);
workflowsRouter.patch("/workflows/:id", workflowsController.patchWorkflow);
workflowsRouter.patch("/:id", workflowsController.patchWorkflow);
workflowsRouter.patch("/workflows/:id/like", workflowsController.toggleLike);
workflowsRouter.patch("/workflows/:id/primary-media", workflowsController.setPrimaryMedia);
workflowsRouter.patch("/items/:id/like", generationsMutation.toggleLike);

workflowsRouter.delete("/workflows/:id", workflowsController.deleteWorkflow);
workflowsRouter.delete("/:id", workflowsController.deleteWorkflow);
workflowsRouter.delete("/items/:id", generationsMutation.deleteItem);
workflowsRouter.delete("/media/:media_id", workflowsController.deleteMedia);

// ── Combined Generation Router ─────────────────────────────────────
export const generationRouter = express.Router();
generationRouter.use("/images", imagesRouter);
generationRouter.use("/video", videoRouter);
generationRouter.use("/prompt", promptRouter);
generationRouter.use("/v2/workflows", v2WorkflowsRouter);
generationRouter.use("/workflows", workflowsRouter);

export {
    imageController,
    videoController,
    generationsQuery,
    projectController,
    generationsMutation,
    workflowsController,
};
export const { generateImage, relightImage, changeImageAngle, removeImageBackground, editImage } = imageController;
export const { generateVideo } = videoController;
export const { getAssets, getUserLibrary, getLibraryWorkflowDetail } = generationsQuery;
export const { getProjectData } = projectController;
export const { deleteGeneration, deleteItem, updateGeneration, toggleLike: toggleItemLike } = generationsMutation;
export const {
    patchWorkflow,
    deleteWorkflow,
    bulkDeleteWorkflows,
    toggleLike,
    bulkToggleLike,
    setPrimaryMedia,
    getWorkflowByMedia,
    detachMediaToNewWorkflow,
    deleteMedia,
} = workflowsController;

export default generationRouter;
