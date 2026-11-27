/**
 * Shared HTTP Controller Helpers — Generation & Image Edit Endpoints
 *
 * Pure HTTP error formatting helper for System 1 (`generation`) controllers.
 * Domain validation, contract parsing, metadata resolution, and ownership checks
 * live exclusively in `GenerationRequestService`.
 */

import { randomUUID } from "node:crypto";

/**
 * Formats and sends a canonical HTTP error response for generation & edit controllers.
 */
export function sendGenerationControllerError(res, err, { logger, actionName, fallbackMessage }) {
  if (err?.code === "QUEUE_DISPATCH_FAILED") {
    logger.error({ err, statusCode: 503 }, `${actionName} queue dispatch failed: ${err?.message || "unknown"}`);
    return res.status(503).json({
      ok: false,
      status: "failed",
      code: "QUEUE_DISPATCH_FAILED",
      message: "Generation service is temporarily unavailable. Please try again shortly.",
      workflowId: err.workflowId,
      mediaId: err.mediaId,
      mediaIds: err.mediaIds,
    });
  }

  const statusCode = err?.statusCode || 500;
  logger.error({ err, statusCode }, `${actionName} error: ${err?.message || String(err)}`);
  const traceId = err?.workflowId || randomUUID();
  return res.status(statusCode).json({
    ok: false,
    code: statusCode >= 500 ? "INTERNAL_ERROR" : (err?.code || "REQUEST_FAILED"),
    message: (err?.isOperational && statusCode < 500) ? err.message : fallbackMessage,
    traceId,
  });
}
