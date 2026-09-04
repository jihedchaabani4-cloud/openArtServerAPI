/**
 * Public Logging Infrastructure Entrypoint.
 *
 * Exposes:
 * - createLogger(moduleName)
 * - runWithContext, setContext, getContext
 * - LogEvents, LogErrorCodes
 * - requestLogger (lazy export / middleware)
 */

import { baseLogger } from "./logger.js";
import { runWithContext, setContext, getContext, getCleanContext } from "./context.js";
import { LogEvents } from "./events.js";
import { LogErrorCodes } from "./errors.js";

/**
 * Creates a module-scoped logger.
 * Automatically injects active LogContext (requestId, userId, jobId, useCase, operation)
 * from AsyncLocalStorage into every emitted log entry.
 *
 * @param {string} moduleName - Architectural category (e.g. 'http', 'wallet', 'workflow')
 * @returns {Object} Scoped logger with debug, info, warn, error, fatal, child methods
 */
export function createLogger(moduleName = "system") {
  const normalizedModule = moduleName.toUpperCase();

  function log(level, arg1, arg2) {
    try {
      const context = getCleanContext();
      let payload = {};
      let message = "";

      if (typeof arg1 === "string") {
        message = arg1;
        if (typeof arg2 === "object" && arg2 !== null) {
          payload = arg2;
        }
      } else if (typeof arg1 === "object" && arg1 !== null) {
        payload = arg1;
        message = typeof arg2 === "string" ? arg2 : (payload.message || payload.msg || "");
      }

      const merged = {
        ...context,
        ...payload,
        module: normalizedModule,
      };

      const formattedMessage = message ? `[${normalizedModule}] ${message}` : `[${normalizedModule}]`;

      baseLogger[level](merged, formattedMessage);
    } catch (err) {
      // Fail-safe: logging error must never crash application flow
      console.error("[LOGGER_INTERNAL_ERROR]", err.message);
    }
  }

  return {
    debug: (arg1, arg2) => log("debug", arg1, arg2),
    info: (arg1, arg2) => log("info", arg1, arg2),
    warn: (arg1, arg2) => log("warn", arg1, arg2),
    error: (arg1, arg2) => log("error", arg1, arg2),
    fatal: (arg1, arg2) => log("fatal", arg1, arg2),
    child: (bindings = {}) => {
      const childPino = baseLogger.child({ module: normalizedModule, ...bindings });
      return {
        debug: (a1, a2) => childPino.debug({ ...getCleanContext(), ...(typeof a1 === "object" ? a1 : {}), module: normalizedModule }, typeof a1 === "string" ? `[${normalizedModule}] ${a1}` : a2 ? `[${normalizedModule}] ${a2}` : `[${normalizedModule}]`),
        info: (a1, a2) => childPino.info({ ...getCleanContext(), ...(typeof a1 === "object" ? a1 : {}), module: normalizedModule }, typeof a1 === "string" ? `[${normalizedModule}] ${a1}` : a2 ? `[${normalizedModule}] ${a2}` : `[${normalizedModule}]`),
        warn: (a1, a2) => childPino.warn({ ...getCleanContext(), ...(typeof a1 === "object" ? a1 : {}), module: normalizedModule }, typeof a1 === "string" ? `[${normalizedModule}] ${a1}` : a2 ? `[${normalizedModule}] ${a2}` : `[${normalizedModule}]`),
        error: (a1, a2) => childPino.error({ ...getCleanContext(), ...(typeof a1 === "object" ? a1 : {}), module: normalizedModule }, typeof a1 === "string" ? `[${normalizedModule}] ${a1}` : a2 ? `[${normalizedModule}] ${a2}` : `[${normalizedModule}]`),
        fatal: (a1, a2) => childPino.fatal({ ...getCleanContext(), ...(typeof a1 === "object" ? a1 : {}), module: normalizedModule }, typeof a1 === "string" ? `[${normalizedModule}] ${a1}` : a2 ? `[${normalizedModule}] ${a2}` : `[${normalizedModule}]`),
      };
    },
  };
}

export {
  runWithContext,
  setContext,
  getContext,
  getCleanContext,
  LogEvents,
  LogErrorCodes,
  baseLogger,
};

export default createLogger;
