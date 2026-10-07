import express from "express";
import * as projectsController from "../controllers/projectsController.js";
import * as foldersController from "../controllers/foldersController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const router = express.Router();

// Apply auth middleware to all project routes
router.use(requireAuth);

// Project Folders & Assets
router.get("/:projectId/folders", foldersController.listProjectFolders);
router.post("/:projectId/folders", rateLimit("folderWrite"), foldersController.createProjectFolder);
router.get("/:projectId/assets", projectsController.listAssets);

router.get("/", projectsController.getAll);
router.post("/", projectsController.create);
router.patch("/:id", projectsController.update);
router.delete("/:id", projectsController.remove);

export default router;
