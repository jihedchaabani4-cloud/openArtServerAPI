import "dotenv/config";
import { useCaseWorker } from "./useCaseWorker.js";
import { runReservationReaper } from "./reservationReaperWorker.js";
import { createLogger } from "../infrastructure/logging/index.js";

const workerLogger = createLogger("worker");

// ── Reservation Reaper — runs every 5 minutes ────────────────────────────────
// Safety net: releases any billing holds that are:
//   - older than 10 minutes (walletService.HOLD_TTL_MS)
//   - not yet settled/released
// Covers: Worker crash where failed event handler also failed, or Worker never restarted.
const REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function startReaper() {
  workerLogger.info({ interval: REAPER_INTERVAL_MS }, "[Reaper] Starting reservation reaper loop");

  // Run immediately on boot (catches any holds from last Worker crash)
  try {
    const count = await runReservationReaper();
    if (count > 0) {
      workerLogger.warn({ count }, `[Reaper] Boot sweep: released ${count} orphaned billing hold(s)`);
    }
  } catch (err) {
    workerLogger.error({ err: err.message }, "[Reaper] Boot sweep failed");
  }

  // Then run every 5 minutes
  setInterval(async () => {
    try {
      await runReservationReaper();
    } catch (err) {
      workerLogger.error({ err: err.message }, "[Reaper] Scheduled sweep failed");
    }
  }, REAPER_INTERVAL_MS);
}

startReaper();

export { useCaseWorker as worker, useCaseWorker };
export default useCaseWorker;
