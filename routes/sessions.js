import express from "express";
import * as sessionsController from "../controllers/sessionsController.js";
import { authenticate } from "../src/middleware/auth.js";

const router = express.Router();

// Apply auth middleware to all session routes
router.use(authenticate);


router.post("/", sessionsController.create);
router.patch("/:id", sessionsController.update);
router.delete("/:id", sessionsController.remove);

export default router;
