/**
 * Bounded-concurrency async worker-pool helper.
 * Never spawns unbounded Promise.all over the entire input list:
 * at most `clampBulkDeleteConcurrency(concurrency)` workers run in flight simultaneously.
 */
import { envConfig, clampBulkDeleteConcurrency } from "../config/env.js";

/**
 * Executes `worker(item, index)` over `items` with bounded concurrency clamped to [1, 15].
 * Preserves output ordering matching `items`.
 * On error, stops starting new items, awaits currently in-flight workers, and rethrows the first error.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{ concurrency?: number } | number} [options]
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, worker, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  if (typeof worker !== "function") {
    throw new TypeError("runWithConcurrency requires a worker function");
  }

  const rawConcurrency = typeof options === "number" ? options : options?.concurrency;
  const limit = clampBulkDeleteConcurrency(
    rawConcurrency === undefined ? envConfig.bulkDeleteConcurrency : rawConcurrency
  );
  const workerCount = Math.min(limit, list.length);
  const results = new Array(list.length);
  let nextIndex = 0;
  let firstError = null;

  async function runWorker() {
    while (!firstError) {
      const currentIndex = nextIndex;
      if (currentIndex >= list.length) break;
      nextIndex += 1;
      try {
        results[currentIndex] = await worker(list[currentIndex], currentIndex);
      } catch (err) {
        if (!firstError) {
          firstError = err;
        }
        break;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  if (firstError) {
    throw firstError;
  }

  return results;
}
