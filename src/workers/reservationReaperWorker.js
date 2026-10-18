import { walletService as containerWallet, mediaWorkflowLifecycleService } from "../container.js";
import { walletService as inMemoryWallet } from "../services/walletService.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const logger = createLogger("reservation-reaper");

/**
 * Sweeps and releases any orphaned credit holds that have exceeded their 10-minute TTL,
 * then reconciles the associated execution/media state via mediaWorkflowLifecycleService.
 *
 * @returns {Promise<number>} Number of released reservations
 */
export async function runReservationReaper({
  walletService: injectedWallet = null,
  lifecycleService: injectedLifecycle = null,
} = {}) {
  const start = Date.now();
  const activeWallet = injectedWallet || containerWallet || inMemoryWallet;
  const activeLifecycle = injectedLifecycle || mediaWorkflowLifecycleService;

  try {
    const expiredHolds = await activeWallet.reapExpiredHolds();
    const holdsList = Array.isArray(expiredHolds) ? expiredHolds : [];
    const reapedCount = Array.isArray(expiredHolds) ? expiredHolds.length : (Number(expiredHolds) || 0);

    for (const hold of holdsList) {
      if (activeLifecycle && (hold.workflowId || hold.mediaId)) {
        await activeLifecycle.failForExpiredHold({
          holdId: hold.holdId || hold.referenceId || hold.id,
          workflowId: hold.workflowId,
          mediaId: hold.mediaId,
          reason: "Generation execution timed out. Your credits have been refunded.",
        }).catch((err) => {
          logger.warn(
            { holdId: hold.holdId, workflowId: hold.workflowId, err: err.message },
            `Failed to mark media failed for expired hold ${hold.holdId}`
          );
        });
      }
    }

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

