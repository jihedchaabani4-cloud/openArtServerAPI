class InMemoryIdempotencyStore {
  constructor() {
    this.cache = new Map();
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

  clear() {
    this.cache.clear();
  }
}

export const idempotencyStore = new InMemoryIdempotencyStore();
export default idempotencyStore;
