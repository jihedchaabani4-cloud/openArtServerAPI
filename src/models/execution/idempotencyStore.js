/**
 * In-Memory Idempotency Store (Phase 1 — Single-Process In-Flight & TTL Cache)
 *
 * ── Deployment & Scaling Semantics ──────────────────────────────────────────
 * - Same process: Duplicate / concurrent requests with same key are deduplicated
 * - Process restart: In-memory cache is lost (ephemeral)
 * - Multiple pods / horizontal scaling: Cache is NOT shared between replicas
 *
 * NOTE: For multi-instance / cluster deployments in Phase 2, this must be backed
 * by a distributed store (e.g. Redis). For Phase 1 single-instance, this process-local
 * Map provides fast, lock-free deduplication.
 * ────────────────────────────────────────────────────────────────────────────
 */
class InMemoryIdempotencyStore {
  constructor() {
    this.cache = new Map();
    this.inFlight = new Map(); // key -> Promise
  }

  async get(key) {
    if (!key) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, { ttlSeconds = 3600 } = {}) {
    if (!key) return;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  getInFlight(key) {
    if (!key) return null;
    return this.inFlight.get(key) || null;
  }

  setInFlight(key, promise) {
    if (!key) return;
    this.inFlight.set(key, promise);
  }

  clearInFlight(key) {
    if (!key) return;
    this.inFlight.delete(key);
  }
}

export const idempotencyStore = new InMemoryIdempotencyStore();
export default idempotencyStore;
