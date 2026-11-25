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
  if (err.code === "QUEUE_DISPATCH_FAILED") {
    return res.status(503).json({
      ok: false,
      status: "failed",
      code: "QUEUE_DISPATCH_FAILED",
      message: err.message,
      workflowId: err.workflowId,
      mediaId: err.mediaId,
      mediaIds: err.mediaIds,
    });
  }

  const statusCode = err.statusCode || 500;
  logger.error({ err, statusCode }, `${actionName} error: ${err.message}`);
  const traceId = err.workflowId || randomUUID();
  return res.status(statusCode).json({
    ok: false,
    code: statusCode >= 500 ? "INTERNAL_ERROR" : (err.code || "REQUEST_FAILED"),
    message: err.isOperational ? err.message : fallbackMessage,
    traceId,
  });
}
