/**
 * System 2: Models Management — Public HTTP API Gateway (#models/api)
 *
 * Exposes public model catalog presentation, schema introspection, and pricing
 * estimation endpoints.
 *
 * Governed by Rule 13: Express isolated strictly to public/api.js.
 */

import { Router } from "express";
import {
  handleGetCatalog,
  handleGetModelDetail,
  handleGetModelSchema,
  handleEstimatePrice,
  handleGetLegacySchema,
  handleEstimateLegacyPrice,
} from "../internal/controllers/modelsController.js";

const router = Router();

router.get("/", handleGetCatalog);
router.get("/:key", handleGetModelDetail);
router.get("/:key/schema", handleGetModelSchema);
router.post("/:key/estimate-price", handleEstimatePrice);
router.get("/:key/:operation/schema", handleGetLegacySchema);
router.post("/:key/:operation/estimate-price", handleEstimateLegacyPrice);

export const modelsRouter = router;
export default router;
