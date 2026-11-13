/**
 * Context manager providing runWithContext, setContext, and getContext
 * backed by Node.js AsyncLocalStorage.
 */
import { asyncLocalStorage } from "./context-storage.js";

/**
 * Execute a synchronous or asynchronous function within an isolated LogContext.
 *
 * @template T
 * @param {Object} context
 * @param {string} [context.requestId]
 * @param {string} [context.jobId]
 * @param {string} [context.userId]
 * @param {string} [context.useCase]
 * @param {string} [context.operation]
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T> | T}
 */
export function runWithContext(context = {}, fn) {
  const parent = asyncLocalStorage.getStore();
  const merged = { ...(parent || {}), ...context };
  return asyncLocalStorage.run(merged, fn);
}

/**
 * Mutate or enrich the active LogContext for the remainder of the current execution.
 *
 * @param {Object} partialContext
 */
export function setContext(partialContext = {}) {
  const store = asyncLocalStorage.getStore();
  if (store && typeof store === "object") {
    Object.assign(store, partialContext);
  }
}

/**
 * Retrieve the currently active LogContext, or undefined if outside a context.
 *
 * @returns {Object|undefined}
 */
export function getContext() {
  return asyncLocalStorage.getStore();
}

/**
 * Returns a clean copy of the current context with empty/null/undefined keys omitted.
 * Conforms to FR-016 (no dummy or null placeholders).
 *
 * @returns {Object}
 */
export function getCleanContext() {
  const store = asyncLocalStorage.getStore();
  if (!store || typeof store !== "object") return {};

  const clean = {};
  for (const [key, val] of Object.entries(store)) {
    if (val !== undefined && val !== null && val !== "") {
      clean[key] = val;
    }
  }
  return clean;
}
