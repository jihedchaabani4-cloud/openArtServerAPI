import "dotenv/config";
import { useCaseWorker, handleUseCaseWorkerFailure } from "./useCaseWorker.js";
import { runReservationReaper } from "#billing/tools";
import { createLogger, envConfig } from "#shared";

const workerLogger = createLogger("worker");

const REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function startReaper() {
  workerLogger.info({ interval: REAPER_INTERVAL_MS }, "[Reaper] Starting reservation reaper loop");

  try {
    const count = await runReservationReaper();
    if (count > 0) {
      workerLogger.warn({ count }, `[Reaper] Boot sweep: released ${count} orphaned billing hold(s)`);
    }
  } catch (err) {
    workerLogger.error({ err: err.message }, "[Reaper] Boot sweep failed");
  }

  // Supports DISABLE_IN_PROCESS_REAPER=true for multi-replica deployments
  if (!envConfig.disableInProcessReaper && !envConfig.isTest) {
    setInterval(async () => {
      try {
        await runReservationReaper();
      } catch (err) {
        workerLogger.error({ err: err.message }, "[Reaper] Scheduled sweep failed");
      }
    }, REAPER_INTERVAL_MS);
  }
}

if (!envConfig.isTest) {
  startReaper();
}

export { useCaseWorker as worker, useCaseWorker, handleUseCaseWorkerFailure };
export default useCaseWorker;
