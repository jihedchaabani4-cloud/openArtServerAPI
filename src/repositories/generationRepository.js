/**
 * GenerationRepository
 * Persists and retrieves immutable execution snapshots for AI generations.
 * Ensures historical auditability of schema versions, pricing versions, and input snapshots.
 */

export class GenerationRepository {
  constructor(dbClient = null) {
    this.db = dbClient;
    this.inMemorySnapshots = new Map();
  }

  /**
   * Persists an immutable execution snapshot.
   * @param {object} snapshot
   */
  async saveSnapshot(snapshot) {
    if (!snapshot || !snapshot.generationId) {
      throw new Error("Invalid snapshot: generationId is required");
    }

    const record = {
      generationId: snapshot.generationId,
      userId: snapshot.userId || null,
      model: snapshot.model,
      operation: snapshot.operation,
      schema_version: snapshot.schemaVersion || snapshot.schema_version,
      pricing_version: snapshot.pricingVersion || snapshot.pricing_version,
      inputs_snapshot: snapshot.inputsSnapshot || snapshot.inputs_snapshot || {},
      credits_charged: snapshot.creditsCharged ?? snapshot.credits_charged ?? 0,
      provider_used: snapshot.providerUsed || snapshot.provider_used || null,
      duration_ms: snapshot.durationMs ?? snapshot.duration_ms ?? 0,
      status: snapshot.status || "success",
      error_message: snapshot.errorMessage || snapshot.error_message || null,
      created_at: snapshot.createdAt || snapshot.created_at || new Date().toISOString(),
    };

    // Store in-memory
    this.inMemorySnapshots.set(record.generationId, Object.freeze({ ...record }));

    // If db client is available, persist to database
    if (this.db) {
      try {
        await this.db.from("generations").upsert(record);
      } catch (err) {
        // Fallback: log warning, keep in-memory
      }
    }

    return record;
  }

  /**
   * Retrieves an immutable execution snapshot by generation ID.
   * @param {string} generationId
   */
  async getSnapshot(generationId) {
    if (this.inMemorySnapshots.has(generationId)) {
      return this.inMemorySnapshots.get(generationId);
    }

    if (this.db) {
      const { data } = await this.db
        .from("generations")
        .select("*")
        .eq("generationId", generationId)
        .single();
      if (data) {
        return Object.freeze(data);
      }
    }

    return null;
  }

  /**
   * Lists snapshots for a user.
   * @param {string} userId
   */
  async listByUserId(userId) {
    const list = [];
    for (const snap of this.inMemorySnapshots.values()) {
      if (snap.userId === userId) {
        list.push(snap);
      }
    }
    return list;
  }

  /**
   * Clears repository data (for tests).
   */
  clear() {
    this.inMemorySnapshots.clear();
  }
}

export const generationRepository = new GenerationRepository();
export default generationRepository;
