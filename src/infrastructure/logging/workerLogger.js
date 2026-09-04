/**
 * Background worker job wrapper.
 * Restores originating LogContext (requestId, userId, useCase, operation)
 * from BullMQ job.data._context and binds jobId to worker execution.
 */
import { runWithContext } from "./context.js";
import { createLogger } from "./index.js";
import { LogEvents } from "./events.js";
import { LogErrorCodes } from "./errors.js";

const workerLogger = createLogger("worker");

/**
 * Wraps a BullMQ job processor function to restore async context and log job lifecycle.
 *
 * @template TData, TResult
 * @param {string} workerName - Name/category of the worker (e.g. 'v2-workflow-worker')
 * @param {(job: Object) => Promise<TResult>} processor - The actual job processor
 * @returns {(job: Object) => Promise<TResult>}
 */
export function wrapWorkerJob(workerName, processor) {
  return async function executeWrappedJob(job) {
    const rawContext = job.data?._context || {};
    const jobId = String(job.id || job.name || "job_unknown");

    const restoredContext = {
      requestId: rawContext.requestId,
      userId: rawContext.userId,
      useCase: rawContext.useCase,
      operation: rawContext.operation,
      jobId,
    };

    return runWithContext(restoredContext, async () => {
      const startTime = performance.now();

      workerLogger.info(
        {
          event: LogEvents.JOB_STARTED,
          worker: workerName,
          jobId,
        },
        `Job ${jobId} started on ${workerName}`
      );

      try {
        const result = await processor(job);
        const durationMs = Math.round(performance.now() - startTime);

        workerLogger.info(
          {
            event: LogEvents.JOB_COMPLETED,
            worker: workerName,
            jobId,
            durationMs,
          },
          `Job ${jobId} completed in ${durationMs}ms`
        );

        return result;
      } catch (err) {
        const durationMs = Math.round(performance.now() - startTime);

        workerLogger.error(
          {
            event: LogEvents.JOB_FAILED,
            worker: workerName,
            jobId,
            durationMs,
            errorCode: err.code || LogErrorCodes.INTERNAL_UNEXPECTED_ERROR,
            err,
          },
          `Job ${jobId} failed: ${err.message}`
        );

        throw err;
      }
    });
  };
}

export default wrapWorkerJob;
