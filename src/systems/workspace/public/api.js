/**
 * System 8: Workspace — Public API Gateway (#workspace/api)
 *
 * Sealed HTTP gateway exposing ONLY the 4 Express routers mounted by src/api/routes.js:
 * projectsRouter, foldersRouter, trashRouter, workspaceBulkRouter.
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

trashRouter.post("/delete", rateLimit("bulkDelete"), trashController.deleteTrashed);
trashRouter.post("/restore-all", trashController.restoreAllWorkflows);
trashRouter.post("/:workflowId/restore", trashController.restoreWorkflow);

// ── Workspace Bulk Operations Router ────────────────────────────────
export const workspaceBulkRouter = express.Router();
workspaceBulkRouter.use(requireAuth);

workspaceBulkRouter.post("/bulk-delete", rateLimit("bulkDelete"), trashController.bulkDeleteWorkspace);
