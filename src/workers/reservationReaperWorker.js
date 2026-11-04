import { walletService as containerWallet, mediaWorkflowLifecycleService } from "../container.js";
import { walletService as inMemoryWallet } from "../services/walletService.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

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
  walletService: injectedWallet = null,
  lifecycleService: injectedLifecycle = undefined,
  logger: customLogger = null,
} = {}) {
  const activeLogger = customLogger || logger;
  const activeWallet = injectedWallet || containerWallet || inMemoryWallet;
  const activeLifecycle = injectedLifecycle === undefined ? mediaWorkflowLifecycleService : injectedLifecycle;

  if (!activeWallet) {
    return [];
  }

  const expiredHolds = typeof activeWallet.reapExpiredHolds === "function"
    ? await activeWallet.reapExpiredHolds()
    : (typeof activeWallet.expireStaleHolds === "function" ? await activeWallet.expireStaleHolds() : []);

  const holdsList = Array.isArray(expiredHolds) ? expiredHolds : [];

  for (const hold of holdsList) {
    if (activeLifecycle && (hold.workflowId || hold.mediaId)) {
      try {
        await activeLifecycle.failForExpiredHold({
          holdId: hold.holdId || hold.referenceId || hold.id,
          workflowId: hold.workflowId,
          mediaId: hold.mediaId,
          reason: "Generation execution timed out. Your credits have been refunded.",
        });
      } catch (err) {
        activeLogger.warn(
          { holdId: hold.holdId || hold.referenceId || hold.id, workflowId: hold.workflowId, err: err.message },
          `Failed to mark media failed for expired hold ${hold.holdId || hold.referenceId || hold.id}: ${err.message}`
        );
      }
    }
  }

  return holdsList;
}

/**
 * Sweeps and releases any orphaned credit holds that have exceeded their 10-minute TTL,
 * reconciles the associated execution/media state via mediaWorkflowLifecycleService,
 * and sweeps stale placeholders.
 *
 * @returns {Promise<number>} Number of released reservations
 */
export async function runReservationReaper({
  walletService: injectedWallet = null,
  lifecycleService: injectedLifecycle = undefined,
} = {}) {
  const start = Date.now();
  const activeLifecycle = injectedLifecycle === undefined ? mediaWorkflowLifecycleService : injectedLifecycle;

  try {
    const holdsList = await reconcileExpiredHolds({
      walletService: injectedWallet,
      lifecycleService: activeLifecycle,
      logger,
    });
    const reapedCount = holdsList.length;

    if (activeLifecycle && typeof activeLifecycle.sweepStalePlaceholders === "function") {
      await activeLifecycle.sweepStalePlaceholders().catch((err) => {
        logger.warn({ err: err.message }, "Failed to sweep stale placeholders in reservation reaper");
      });
    }

    logger.info(
      {
        reapedCount,
        durationMs: Date.now() - start,
        event: LogEvents.WALLET_HOLD_EXPIRED || "wallet.hold.expired"
      },
      `Reservation reaper swept ${reapedCount} expired holds and reconciled media state`
    );
    return reapedCount;
  } catch (err) {
    logger.error(
      {
        err,
        durationMs: Date.now() - start,
        event: "wallet.reaper.failed"
      },
      `Reservation reaper failed: ${err.message}`
    );
    throw err;
  }
}
