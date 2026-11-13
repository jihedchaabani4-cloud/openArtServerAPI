/**
 * Legacy Re-export for ErrorSystem.
 * Canonical implementation now lives in src/shared/errors/
 */
import { ErrorSystem as BaseErrorSystem } from "../shared/errors/index.js";
import { logger } from "./logger.js";

export const ErrorSystem = {
  process(err, context = {}) {
    return BaseErrorSystem.process(err, context, logger);
  },
};

export default ErrorSystem;
