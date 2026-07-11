import express from "express";
import * as imageController      from "../controllers/imageController.js";
import * as editImageController  from "../controllers/editImageController.js";
import { requireAuth }           from "../src/middleware/auth.js";
import { startWorkflow }         from "../controllers/workflowArchitectureController.js";
import { findMigrationInventoryItem, LEGACY_PATH_STATUSES } from "../src/registry/migrationInventory.js";

const router = express.Router();

/** POST /api/images/generated — image generation (new workflow) */
router.post("/generated", requireAuth, (req, res, next) => {
  const item = findMigrationInventoryItem("image-generation");
  const useLegacy = item && item.legacyPathStatus === LEGACY_PATH_STATUSES.ACTIVE;
  if (useLegacy) {
    return imageController.generateV2(req, res, next);
  }
  
  // Set featureId for workflow runner using the new target registry entry.
  // Wrap the frontend payload as `input` so workflowArchitectureController
  // can forward all fields (prompt, model_name, project_id, etc.) into the
  // workflow context — the controller destructures { featureId, input } from
  // req.body, not the raw frontend fields at the top level.
  const { featureId: _ignore, ...frontendPayload } = req.body;
  req.body = {
    featureId: item ? item.targetRegistryEntry : "first-slice-image-generation",
    input: frontendPayload,
  };
  return startWorkflow(req, res, next);
});

router.post("/generated/edit/existing", requireAuth, editImageController.generateEdit);

export default router;
