import express from "express";
import * as projectsController from "../controllers/projectsController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

// Apply auth middleware to all project routes
router.use(requireAuth);

router.get("/", projectsController.getAll);
router.post("/", projectsController.create);
router.patch("/:id", projectsController.update);
router.delete("/:id", projectsController.remove);

export default router;
