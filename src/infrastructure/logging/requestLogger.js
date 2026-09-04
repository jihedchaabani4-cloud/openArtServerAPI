/**
 * Express HTTP request logger middleware.
 * Automatically initializes LogContext with a unique requestId, replaces morgan,
 * and emits structured [HTTP] start and completion logs.
 */
import { randomUUID } from "node:crypto";
import { runWithContext, getContext } from "./context.js";
import { createLogger } from "./index.js";
import { LogEvents } from "./events.js";

const httpLogger = createLogger("http");

export function requestLogger(options = {}) {
  const ignorePaths = new Set(options.ignorePaths || ["/favicon.ico"]);

  return function handleRequest(req, res, next) {
    const rawPath = req.originalUrl || req.url || "/";
    if (ignorePaths.has(rawPath)) {
      return next();
    }

    // 1. Establish Correlation ID
    const incomingId = req.headers["x-request-id"] || req.headers["x-correlation-id"];
    const requestId = (typeof incomingId === "string" && incomingId.trim())
      ? incomingId.trim()
      : `req_${randomUUID()}`;

    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startTime = performance.now();

    // 2. Wrap execution within AsyncLocalStorage LogContext
    runWithContext({ requestId }, () => {
      // Log request started at debug level to avoid terminal spam, or info if needed
      httpLogger.debug(
        {
          event: LogEvents.HTTP_REQUEST_STARTED,
          method: req.method,
          path: rawPath,
          ip: req.ip || req.headers["x-forwarded-for"],
        },
        `${req.method} ${rawPath} started`
      );

      // 3. Listen for completion
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

export default requestLogger;
