/**
 * Express HTTP request logger & BullMQ worker logger middlewares.
 */
import { randomUUID } from "node:crypto";
import { runWithContext, getContext } from "./context.js";
import { createLogger } from "./index.js";
import { LogEvents } from "./events.js";
import { LogErrorCodes } from "./errors.js";

const httpLogger = createLogger("http");
const workerLogger = createLogger("worker");

export function requestLogger(options = {}) {
  const ignorePaths = new Set(options.ignorePaths || ["/favicon.ico"]);

  return function handleRequest(req, res, next) {
    const rawPath = req.originalUrl || req.url || "/";
    if (ignorePaths.has(rawPath)) {
      return next();
    }

    const incomingId = req.headers["x-request-id"] || req.headers["x-correlation-id"];
    const requestId = (typeof incomingId === "string" && incomingId.trim())
      ? incomingId.trim()
      : `req_${randomUUID()}`;

    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startTime = performance.now();

    runWithContext({ requestId }, () => {
      httpLogger.debug(
        {
          event: LogEvents.HTTP_REQUEST_STARTED,
          method: req.method,
          path: rawPath,
          ip: req.ip || req.headers["x-forwarded-for"],
        },
        `${req.method} ${rawPath} started`
      );

      res.on("finish", () => {
        const durationMs = Math.round(performance.now() - startTime);
        const statusCode = res.statusCode;
        const isError = statusCode >= 400;

        const eventPayload = {
          event: isError ? LogEvents.HTTP_REQUEST_FAILED : LogEvents.HTTP_REQUEST_COMPLETED,
          method: req.method,
          path: rawPath,
          statusCode,
          durationMs,
        };

        const summary = `${statusCode} ${req.method} ${rawPath} (${durationMs}ms)`;
        if (statusCode >= 500) {
          httpLogger.error(eventPayload, summary);
        } else if (statusCode >= 400) {
          httpLogger.warn(eventPayload, summary);
        } else {
          httpLogger.info(eventPayload, summary);
        }
      });

      next();
    });
  };
}

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
            errorCode: err?.code || LogErrorCodes.INTERNAL_UNEXPECTED_ERROR,
            err,
          },
          `Job ${jobId} failed on ${workerName}: ${err.message}`
        );

        throw err;
      }
    });
  };
}
