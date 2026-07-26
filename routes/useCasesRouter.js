import express from "express";
import { requireAuth } from "../src/middleware/auth.js";
import { listUseCases } from "../src/use-cases/useCaseRegistry.js";
import { run as runUseCase } from "../src/use-cases/useCaseRunner.js";
import { logV2Event } from "../src/v2/logging/v2Logger.js";
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { walletService, pricingService } from "../src/container.js";
import { randomUUID } from "node:crypto";

const router = express.Router();
let cachedRegistries = null;

function getRegistries() {
  if (!cachedRegistries) {
    cachedRegistries = loadRegistries();
  }
  return cachedRegistries;
}

// GET /api/use-cases
router.get("/", requireAuth, async (req, res, next) => {
  const started = Date.now();
  const traceId = req.headers["x-trace-id"] || randomUUID();
  const { category, type } = req.query;

  try {
    const list = listUseCases({
      category: category ? String(category) : undefined,
      type: type ? String(type) : undefined,
    });

    logV2Event({
      traceId,
      operation: "use-cases.list",
      durationMs: Date.now() - started,
      status: "success",
      metadata: { count: list.length, category, type },
    });

    res.json({ useCases: list });
  } catch (error) {
    logV2Event({
      traceId,
      operation: "use-cases.list",
      durationMs: Date.now() - started,
      status: "error",
      errorCode: "LIST_FAILED",
      message: error.message,
    });
    next(error);
  }
});

// GET /api/use-cases/:useCaseId
router.get("/:useCaseId", requireAuth, async (req, res) => {
  const started = Date.now();
  const traceId = req.headers["x-trace-id"] || randomUUID();
  const useCaseId = req.params.useCaseId;

  try {
    const useCase = getUseCase(useCaseId);
    if (!useCase) {
      logV2Event({
        traceId,
        operation: "use-cases.detail",
        durationMs: Date.now() - started,
        status: "error",
        errorCode: "USE_CASE_NOT_FOUND",
        message: `Use Case ${useCaseId} not found`,
      });
      return res.status(404).json({
        code: "USE_CASE_NOT_FOUND",
        message: `Use Case "${useCaseId}" not found`,
      });
    }

    logV2Event({
      traceId,
      operation: "use-cases.detail",
      durationMs: Date.now() - started,
      status: "success",
      metadata: { useCaseId },
    });

    res.json({ useCase });
  } catch (error) {
    logV2Event({
      traceId,
      operation: "use-cases.detail",
      durationMs: Date.now() - started,
      status: "error",
      errorCode: "DETAIL_FAILED",
      message: error.message,
    });
    res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  }
});

// POST /api/use-cases/:useCaseId/run
router.post("/:useCaseId/run", requireAuth, async (req, res) => {
  const started = Date.now();
  const useCaseId = req.params.useCaseId;
  const traceId = req.headers["x-trace-id"] || randomUUID();
  const userId = req.user?.id || null;
  const input = req.body || {};

  try {
    const registries = getRegistries();
    const result = await runUseCase({
      useCaseId,
      input,
      userId,
      walletService,
      pricingService,
      registries,
    });

    logV2Event({
      traceId,
      operation: "use-cases.run",
      durationMs: Date.now() - started,
      status: "success",
      message: `Successfully executed Use Case ${useCaseId}`,
      metadata: { useCaseId, executionId: result.executionId },
    });

    // V2 startWorkflowRun enqueues BullMQ and returns "pending".
    // 202 Accepted matches Principle III (Queue-First).
    res.status(202).json({
      executionId: result.executionId,
      status: result.status,
      totalCost: result.totalCost,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const errorCode = error.code || "RUN_FAILED";

    logV2Event({
      traceId,
      operation: "use-cases.run",
      durationMs: Date.now() - started,
      status: "error",
      errorCode,
      message: error.message,
      metadata: {
        useCaseId,
        statusCode,
        required: error.required,
        available: error.available,
      },
    });

    res.status(statusCode).json({
      code: errorCode,
      message: error.message,
      ...(error.required !== undefined ? { required: error.required } : {}),
      ...(error.available !== undefined ? { available: error.available } : {}),
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }
});

export default router;
