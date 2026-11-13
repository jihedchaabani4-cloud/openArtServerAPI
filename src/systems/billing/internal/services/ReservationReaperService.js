/**
 * @owns System 3: Billing & Wallet
 *
 * ReservationReaperService
 * ─────────────────────────────────────────────────────────────────────────────
 * Reconciles expired credit holds by releasing held balances and updating
 * associated media / execution state. Provides per-row error isolation.
 */
import { createLogger, LogEvents } from "#shared";
import { markMediaFailed } from "#media/tools";

const logger = createLogger("reservation-reaper");

/**
 * Reconciles expired holds by releasing holds and updating associated media/workflow state to failed.
 * Provides per-row error isolation so a failure on one item never halts the others or crashes callers.
 *
 * @param {Object} [options]
 * @param {Object} [options.walletService]
 * @param {Object} [options.lifecycleService]
 * @param {Object} [options.logger]
 * @returns {Promise<Array<Object>>} List of reaped hold records
 */
export async function reconcileExpiredHolds({
  walletService = null,
  lifecycleService = null,
  logger: customLogger = null,
} = {}) {
  const activeLogger = customLogger || logger;
  if (!walletService || typeof walletService.reapExpiredHolds !== "function") {
    return [];
  }

  const expiredHolds = await walletService.reapExpiredHolds();
  const holdsList = Array.isArray(expiredHolds) ? expiredHolds : [];

  for (const hold of holdsList) {
    if (lifecycleService && (hold.workflowId || hold.mediaId)) {
      try {
        await lifecycleService.failForExpiredHold({
          holdId: hold.holdId,
          workflowId: hold.workflowId,
          mediaId: hold.mediaId,
          reason: "Generation execution timed out. Your credits have been refunded.",
        });
      } catch (err) {
        activeLogger.warn(
          { holdId: hold.holdId, workflowId: hold.workflowId, err: err.message },
          `Failed to mark media failed for expired hold ${hold.holdId}: ${err.message}`
        );
      }
    } else if (hold.mediaId) {
      try {
        await markMediaFailed({
          mediaId: hold.mediaId,
          errorCode: "EXECUTION_TIMEOUT",
          errorMessage: "Generation execution timed out. Your credits have been refunded.",
        });
      } catch (err) {
        activeLogger.warn(
          { holdId: hold.holdId, mediaId: hold.mediaId, err: err.message },
          `Failed to mark media failed for expired hold ${hold.holdId}: ${err.message}`
        );
      }
    }
  }

  return holdsList;
}

/**
 * Sweeps and releases orphaned credit holds that have exceeded their TTL,
 * reconciling associated execution/media state.
 *
 * @param {Object} [options]
 * @param {Object} [options.walletService]
 * @param {Object} [options.lifecycleService]
 * @returns {Promise<number>} Number of released reservations
 */
export async function handleExpireStaleHolds({
  walletService = null,
  lifecycleService = null,
} = {}) {
  const start = Date.now();

  try {
    const holdsList = await reconcileExpiredHolds({
      walletService,
      lifecycleService,
      logger,
    });
    const reapedCount = holdsList.length;

    if (lifecycleService && typeof lifecycleService.sweepStalePlaceholders === "function") {
      await lifecycleService.sweepStalePlaceholders().catch((err) => {
        logger.warn({ err: err.message }, "Failed to sweep stale placeholders in reservation reaper");
      });
    }

    logger.info(
      {
        reapedCount,
        durationMs: Date.now() - start,
        event: LogEvents.WALLET_HOLD_EXPIRED || "wallet.hold.expired",
      },
      `Reservation reaper swept ${reapedCount} expired holds and reconciled media state`
    );
    return reapedCount;
  } catch (err) {
    logger.error(
      {
        err,
        durationMs: Date.now() - start,
        event: "wallet.reaper.failed",
      },
      `Reservation reaper failed: ${err.message}`
    );
    throw err;
  }
}

export default {
  reconcileExpiredHolds,
  handleExpireStaleHolds,
};
