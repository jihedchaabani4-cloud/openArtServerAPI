/**
 * ╔═══════════════════════════════════════════════════════════════╗
 *  statusConstants.js  –  Single source of truth for all statuses
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Centralise TOUTES les constantes de statut utilisées dans l'app
 * (media, workflow, génération, etc.) pour éviter les magic strings
 * éparpillées dans le codebase.
 */

// ── Media / Workflow canonical statuses ──────────────────────────
export const MEDIA_STATUS = Object.freeze({
  PROCESSING: "processing",
  PENDING:    "pending",
  SUCCESS:    "success",
  FAILED:     "failed",
  COMPLETED:  "completed",
  REJECTED:   "rejected",
  ERROR:      "error",
  UPLOADING:  "uploading",
  IN_PROGRESS:"in_progress",
  STARTING:   "starting",
  QUEUED:     "queued",
});

export const WORKFLOW_STATUS = Object.freeze({
  PROCESSING: "processing",
  SUCCESS:    "success",
  FAILED:     "failed",
  COMPLETED:  "completed",
});

// ── Legacy alias (V1StorageBridge compat) ────────────────────────
export const MEDIA_WORKFLOW_STATUS = Object.freeze({
  PROCESSING: MEDIA_STATUS.PROCESSING,
  SUCCESS:    MEDIA_STATUS.SUCCESS,
  FAILED:     MEDIA_STATUS.FAILED,
});

// ── Status group helpers ─────────────────────────────────────────
export const PROCESSING_STATUSES = Object.freeze([
  MEDIA_STATUS.PROCESSING,
  MEDIA_STATUS.PENDING,
  MEDIA_STATUS.UPLOADING,
  MEDIA_STATUS.IN_PROGRESS,
  MEDIA_STATUS.STARTING,
  MEDIA_STATUS.QUEUED,
]);

export const REJECTED_STATUSES = Object.freeze([
  MEDIA_STATUS.REJECTED,
  MEDIA_STATUS.FAILED,
  MEDIA_STATUS.ERROR,
]);

export const SUCCESS_STATUSES = Object.freeze([
  MEDIA_STATUS.SUCCESS,
  MEDIA_STATUS.COMPLETED,
]);

// ── Step IDs ─────────────────────────────────────────────────────
export const STEP_ID = Object.freeze({
  GENERATION: "GEN",
  EDIT:       "EDIT",
  VIDEO:      "VID",
  UPSCALE:    "UPSCALE",
});

// ── Workflow types ───────────────────────────────────────────────
export const WORKFLOW_TYPE = Object.freeze({
  GENERATION:    "GENERATION",
  ELEMENT_SHEET: "ELEMENT_SHEET",
});

// ── Helpers ──────────────────────────────────────────────────────

/** @param {string} status */
export function isProcessing(status) {
  return PROCESSING_STATUSES.includes((status || "").toLowerCase());
}

/** @param {string} status */
export function isFailed(status) {
  return REJECTED_STATUSES.includes((status || "").toLowerCase());
}

/** @param {string} status */
export function isSuccess(status) {
  return SUCCESS_STATUSES.includes((status || "").toLowerCase());
}

/** @param {string} status  @param {boolean} [hasUrl=false] */
export function isCompleted(status, hasUrl = false) {
  const s = (status || "").toLowerCase();
  if (isSuccess(s)) return true;
  return hasUrl && !isProcessing(s) && !isFailed(s);
}
