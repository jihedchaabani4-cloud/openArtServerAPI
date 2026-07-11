import express from "express";
import * as videoController from "../controllers/videoController.js";
import { requireAuth } from "../src/middleware/auth.js";
import { startWorkflow } from "../controllers/workflowArchitectureController.js";
import { findMigrationInventoryItem, LEGACY_PATH_STATUSES } from "../src/registry/migrationInventory.js";

const router = express.Router();

/** POST /api/video/generated — video generation */
router.post("/generated", requireAuth, (req, res, next) => {
  const item = findMigrationInventoryItem("video-generation");
  const useLegacy = item && item.legacyPathStatus === LEGACY_PATH_STATUSES.ACTIVE;
  if (useLegacy) {
    return videoController.generateVideo(req, res, next);
  }
  
  // Wrap the frontend payload as `input` so workflowArchitectureController
  // can forward all fields into the workflow context.
  const { featureId: _ignore, ...frontendPayload } = req.body || {};
  req.body = {
    featureId: item ? item.targetRegistryEntry : "first-slice-video-generation",
    input: frontendPayload,
  };
  return startWorkflow(req, res, next);
});

/** POST /api/video/extend — video extension */
router.post("/extend", requireAuth, videoController.extendVideo);

/** POST /api/video/edit — video editing */
router.post("/edit", requireAuth, videoController.editVideo);

/** POST /api/video/motion — Motion Control specifically */
router.post("/motion", requireAuth, videoController.motionControl);



export default router;
