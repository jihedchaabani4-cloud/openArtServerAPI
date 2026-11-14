/**
 * System 8: Workspace — Public API Gateway (#workspace/api)
 *
 * Exposes HTTP routers for Projects, Folders, and Trash endpoints.
 * Isolates express web framework strictly to public/api.js per Rule 13.
 */

import express from "express";
import * as projectsController from "../internal/controllers/projectsController.js";
import * as foldersController from "../internal/controllers/foldersController.js";
import * as trashController from "../internal/controllers/trashController.js";
import { requireAuth, rateLimit } from "#identity/tools";

// ── Projects Router ─────────────────────────────────────────────────
export const projectsRouter = express.Router();
projectsRouter.use(requireAuth);

projectsRouter.post("/:projectId/folders", rateLimit("folderWrite"), foldersController.createProjectFolder);
projectsRouter.get("/:projectId/assets", projectsController.listAssets);
projectsRouter.get("/", projectsController.getAll);
projectsRouter.post("/", projectsController.create);
projectsRouter.patch("/:id", projectsController.update);
projectsRouter.delete("/:id", projectsController.remove);

// ── Folders Router ──────────────────────────────────────────────────
export const foldersRouter = express.Router();
foldersRouter.use(requireAuth);

foldersRouter.patch("/:folderId", rateLimit("folderWrite"), foldersController.updateFolder);
foldersRouter.delete("/:folderId", rateLimit("folderWrite"), foldersController.deleteFolder);

// ── Trash Router ────────────────────────────────────────────────────
export const trashRouter = express.Router();
trashRouter.use(requireAuth);

trashRouter.post("/restore-all", trashController.restoreAllWorkflows);
trashRouter.post("/:workflowId/restore", trashController.restoreWorkflow);

// ── Unified Workspace Router ─────────────────────────────────────────
export const workspaceRouter = express.Router();
workspaceRouter.use("/projects", projectsRouter);
workspaceRouter.use("/folders", foldersRouter);
workspaceRouter.use("/trash", trashRouter);

export const { getAll, create, update, remove, listAssets } = projectsController;
export const { createProjectFolder, updateFolder, deleteFolder } = foldersController;
export const { restoreWorkflow, restoreAllWorkflows } = trashController;
export { projectsController, foldersController, trashController };

export default workspaceRouter;
