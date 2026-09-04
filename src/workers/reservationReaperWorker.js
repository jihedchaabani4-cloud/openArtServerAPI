import { walletService } from "../services/walletService.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const logger = createLogger("reservation-reaper");

/**
 * Sweeps and releases any orphaned credit holds that have exceeded their 10-minute TTL.
 *
 * @returns {Promise<number>} Number of released reservations
 */
export async function runReservationReaper() {
  const start = Date.now();
  try {
    const reapedCount = await walletService.reapExpiredHolds();
    logger.info(
      {
        reapedCount,
        durationMs: Date.now() - start,
        event: LogEvents.WALLET_HOLD_EXPIRED || "wallet.hold.expired"
      },
      `Reservation reaper swept ${reapedCount} expired holds`
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
