import express from "express";
import * as workspacesController from "../controllers/workspacesController.js";

const router = express.Router();

router.get("/", workspacesController.getAll);
router.post("/", workspacesController.create);
router.patch("/:id", workspacesController.update);
router.delete("/:id", workspacesController.remove);
router.post("/:id/empty", workspacesController.empty);

export default router;
