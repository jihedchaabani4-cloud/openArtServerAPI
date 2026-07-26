import express from "express";
import { requireAuth } from "../src/middleware/auth.js";
import { listManifests } from "../src/v2/nodes/manifests/nodeManifestRegistry.js";
import { logV2Event } from "../src/v2/logging/v2Logger.js";
import { randomUUID } from "node:crypto";

const router = express.Router();

// GET /api/v2/nodes/manifests
router.get("/manifests", requireAuth, async (req, res, next) => {
  const started = Date.now();
  const traceId = req.headers["x-trace-id"] || randomUUID();

  try {
    const manifests = listManifests();

    logV2Event({
      traceId,
      operation: "v2.nodes.manifests",
      durationMs: Date.now() - started,
      status: "success",
      metadata: { count: manifests.length },
    });

    res.json({ nodes: manifests });
  } catch (error) {
    logV2Event({
      traceId,
      operation: "v2.nodes.manifests",
      durationMs: Date.now() - started,
      status: "error",
      errorCode: "MANIFEST_LIST_FAILED",
      message: error.message,
    });
    next(error);
  }
});

export default router;
