/**
 * AsyncLocalStorage storage instance for propagating LogContext.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const asyncLocalStorage = new AsyncLocalStorage();

export default asyncLocalStorage;
