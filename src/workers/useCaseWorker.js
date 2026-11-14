// Preserves structured error logging: updateMedia(mediaId).catch((dbErr) => { workerLogger.error(...) })
// Registers .on("failed", handleUseCaseWorkerFailure) in src/systems/generation/internal/workers/useCaseWorker.js
export * from "#generation/tools";
export { useCaseWorker as default } from "#generation/tools";
