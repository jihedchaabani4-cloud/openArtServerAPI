/**
 * System 2: Models Management — Public HTTP API Gateway (#models/api)
 *
 * Exposes model catalog presentation, schema introspection, pricing estimation,
 * and admin registry reload endpoints.
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 2)
 * - Rule 13: Express isolated strictly to public/api.js
 */

import { Router } from "express";
import {
  formatModelDto,
  handleGetCatalog,
  handleReloadRegistry,
  handleGetModelDetail,
  handleGetModelSchema,
  handleEstimatePrice,
  handleGetLegacySchema,
  handleEstimateLegacyPrice,
} from "../internal/controllers/modelsController.js";

const router = Router();

router.get("/", handleGetCatalog);
router.post("/admin/reload", handleReloadRegistry);
router.get("/:key", handleGetModelDetail);
router.get("/:key/schema", handleGetModelSchema);
router.post("/:key/estimate-price", handleEstimatePrice);
router.get("/:key/:operation/schema", handleGetLegacySchema);
router.post("/:key/:operation/estimate-price", handleEstimateLegacyPrice);

export { formatModelDto };
export const modelsRouter = router;
export default router;
