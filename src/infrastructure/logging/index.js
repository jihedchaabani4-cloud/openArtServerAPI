/**
 * Legacy Re-export for Logging Infrastructure.
 * Canonical implementation now lives in src/shared/logger/
 */
export {
  createLogger,
  runWithContext,
  setContext,
  getContext,
  getCleanContext,
  LogEvents,
  LogErrorCodes,
  baseLogger,
} from "../../shared/logger/index.js";

import { createLogger } from "../../shared/logger/index.js";
export default createLogger;
