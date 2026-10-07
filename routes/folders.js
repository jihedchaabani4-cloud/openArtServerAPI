import express from "express";
import * as foldersController from "../controllers/foldersController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const router = express.Router();

router.use(requireAuth);

router.patch("/:folderId", rateLimit("folderWrite"), foldersController.updateFolder);
router.delete("/:folderId", rateLimit("folderWrite"), foldersController.deleteFolder);

export default router;
