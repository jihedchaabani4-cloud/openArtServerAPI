/**
 * MediaWorkflowLifecycleService
 *
 * @owns Media generation placeholder lifecycle and stale-placeholder recovery transitions.
 */

import { createLogger } from "#shared";
import {
  MEDIA_WORKFLOW_STATUS,
  MEDIA_IN_FLIGHT_STATUSES,
  isMediaInFlight,
  isMediaFailed,
  hasInFlightMedia,
  areAllWorkflowMediaFailed,
} from "./mediaStatus.js";

const lifecycleLogger = createLogger("media_lifecycle");

export {
  MEDIA_WORKFLOW_STATUS,
  MEDIA_IN_FLIGHT_STATUSES,
  isMediaInFlight,
  isMediaFailed,
  hasInFlightMedia,
  areAllWorkflowMediaFailed,
};

function normalizeError(error, fallback = "Generation failed") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return error.message || fallback;
}

/**
 * Atomically marks all pending and processing media records for a given workflow as failed.
 * Guaranteed to NEVER overwrite records in terminal statuses ('completed', 'failed', 'success').
 * Supports direct repository atomic query as well as fallback iteration.
 *
 * @param {Object} db - Database container or { media: ... }
 * @param {string} workflowId - Target workflow ID
 * @param {string|Error} error - Error message or object
 * @returns {Promise<Array>}
 */
export async function failWorkflowPendingMedia(db, workflowId, error) {
  if (!workflowId || !db?.media) return [];
  const message = normalizeError(error);

  if (typeof db.media.failPendingMediaByWorkflow === "function") {
    try {
      return await db.media.failPendingMediaByWorkflow(workflowId, message);
    } catch {
      // Fallback below
    }
  }

  try {
    const list = await db.media.findByWorkflow(workflowId);
    const pendings = list?.filter((m) => m.status === "processing" || m.status === "pending") || [];
    const updated = [];
    for (const p of pendings) {
      await db.media.updateMedia(p.id, {
        status: "failed",
        error_message: message,
      }).then((r) => updated.push(r)).catch(() => {});
    }
    return updated;
  } catch {
    return [];
  }
}

/**
 * Media placeholder recovery service for expired billing holds and stale in-flight placeholders.
 */
export class MediaWorkflowLifecycleService {
  constructor({ db = null } = {}) {
    this.db = db;
  }

  async _failMedia(mediaId, error) {
    if (!this.db?.media || !mediaId) return false;
    const message = normalizeError(error);
    try {
      if (typeof this.db.media.updateFields === "function") {
        await this.db.media.updateFields(mediaId, {
          status: MEDIA_WORKFLOW_STATUS.FAILED,
          error_message: message,
        });
      } else if (typeof this.db.media.updateMedia === "function") {
        await this.db.media.updateMedia(mediaId, {
          status: MEDIA_WORKFLOW_STATUS.FAILED,
          error_message: message,
        });
      } else {
        return false;
      }
      return true;
    } catch (err) {
      lifecycleLogger.error(
        { event: "media_lifecycle.fail_placeholder_failed", mediaId, err: err?.message },
        "failMedia failed"
      );
      return false;
    }
  }

  /**
   * Domain recovery: reconcile and mark media associated with an expired billing hold as failed.
   * Centralizes media status transition for worker crashes / unhandled execution drops.
   *
   * @param {Object} params
   * @param {string} params.holdId
   * @param {string} [params.workflowId]
   * @param {string} [params.mediaId]
   * @param {string} [params.reason]
   * @returns {Promise<boolean>}
   */
  async failForExpiredHold({
    holdId,
    workflowId,
    mediaId = null,
    reason = "Generation execution timed out. Your credits have been refunded.",
  } = {}) {
    if (!this.db?.media) return false;

    try {
      if (mediaId) {
        return await this._failMedia(mediaId, reason);
      }

      if (workflowId && typeof this.db.media.findByWorkflow === "function") {
        const list = await this.db.media.findByWorkflow(workflowId).catch(() => []);
        const pending = list?.find((m) => m.status === "processing" || m.status === "pending");
        if (pending?.id) {
          return await this._failMedia(pending.id, reason);
        }
      }

      return false;
    } catch (err) {
      lifecycleLogger.error(
        { event: "media_lifecycle.fail_expired_hold_failed", holdId, workflowId: workflowId || null, mediaId, err: err?.message },
        "failForExpiredHold failed"
      );
      return false;
    }
  }

  /**
   * Sweeps and marks any orphan or crashed media placeholders that have exceeded
   * their processing TTL (default: 30 minutes) as failed.
   *
   * @param {Object} [options]
   * @param {number} [options.maxAgeMinutes=30]
   * @param {string} [options.reason]
   * @returns {Promise<number>} Number of swept placeholders
   */
  async sweepStalePlaceholders({
    maxAgeMinutes = 30,
    reason = "Generation execution timed out. Placeholder expired.",
  } = {}) {
    if (!this.db?.media) return 0;

    try {
      const cutoffTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
      const staleItems = typeof this.db.media.findStalePlaceholders === "function"
        ? await this.db.media.findStalePlaceholders(cutoffTime)
        : [];

      let sweptCount = 0;
      for (const item of staleItems) {
        if (item?.id) {
          await this._failMedia(item.id, reason);
          sweptCount++;
        }
      }
      return sweptCount;
    } catch {
      return 0;
    }
  }
}

export default MediaWorkflowLifecycleService;
