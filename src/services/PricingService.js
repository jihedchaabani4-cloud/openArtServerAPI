/**
 * PricingService
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides credit cost lookups for model / operation / quality combinations
 * from the pricing_rules PostgreSQL table.
 *
 * Architecture:
 *   PostgreSQL pricing_rules — source of truth (admin-managed)
 *   Redis cache             — acceleration layer (TTL 300s)
 *
 * Cache key pattern: pricing:{modelKey}:{operationType}:{qualityTier}
 * Cache invalidation: explicit DEL on admin update (via updateRule)
 *
 * Performance target: ≤ 100ms on cache hit (SC-004)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class PricingService {
  /** Redis TTL for cached pricing rules (5 minutes) */
  CACHE_TTL_SECONDS = 300;

  /**
   * @param {import('@supabase/supabase-js').SupabaseClient} supabase
   * @param {import('ioredis').Redis} redis — existing ioredis connection (redisConnection from queue/redis.js)
   */
  constructor(supabase, redis) {
    this.supabase = supabase;
    this.redis = redis;
  }

  /**
   * Get credit cost for a specific model/operation/quality combination.
   * Checks Redis first; falls back to PostgreSQL on miss.
   *
   * @returns {{ modelKey, operationType, qualityTier, creditCost, isActive, cached: boolean }}
   * @throws Error with code 'PRICING_NOT_FOUND' if no active rule exists
   */
  async getPrice(modelKey, operationType, qualityTier) {
    const cacheKey = this._cacheKey(modelKey, operationType, qualityTier);

    // ── Cache check ──────────────────────────────────────────────────────────
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null) {
        return { ...JSON.parse(cached), cached: true };
      }
    } catch (redisErr) {
      // Cache read failure → fall through to DB (fail open)
      console.warn("[PricingService] Redis read error — falling back to DB:", redisErr?.message);
    }

    // ── DB lookup ────────────────────────────────────────────────────────────
    const { data, error } = await this.supabase
      .from("pricing_rules")
      .select("id, model_key, operation_type, quality_tier, credit_cost, is_active")
      .eq("model_key", modelKey)
      .eq("operation_type", operationType)
      .eq("quality_tier", qualityTier)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw new Error(`[PricingService] DB error: ${error.message}`);

    if (!data) {
      const notFound = new Error(
        `No active pricing rule found for ${modelKey} / ${operationType} / ${qualityTier}`
      );
      notFound.code = "PRICING_NOT_FOUND";
      throw notFound;
    }

    const result = {
      id: data.id,
      modelKey: data.model_key,
      operationType: data.operation_type,
      qualityTier: data.quality_tier,
      creditCost: Number(data.credit_cost),
      isActive: data.is_active,
    };

    // ── Populate cache ───────────────────────────────────────────────────────
    try {
      await this.redis.setex(cacheKey, this.CACHE_TTL_SECONDS, JSON.stringify(result));
    } catch (redisErr) {
      console.warn("[PricingService] Redis write error — cache not populated:", redisErr?.message);
    }

    return { ...result, cached: false };
  }

  /**
   * Update a pricing rule and immediately invalidate its Redis cache entry.
   *
   * @param {string} id — UUID of the pricing_rules row
   * @param {{ creditCost?: number, isActive?: boolean }} updates
   * @returns {{ rule, cacheInvalidated: boolean }}
   */
  async updateRule(id, updates) {
    const dbUpdates = {};
    if (updates.creditCost !== undefined) dbUpdates.credit_cost = updates.creditCost;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;

    const { data, error } = await this.supabase
      .from("pricing_rules")
      .update(dbUpdates)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error) throw new Error(`[PricingService] updateRule failed: ${error.message}`);
    if (!data) throw new Error(`[PricingService] Pricing rule ${id} not found`);

    // Invalidate cache for this rule
    let cacheInvalidated = false;
    try {
      const cacheKey = this._cacheKey(data.model_key, data.operation_type, data.quality_tier);
      await this.redis.del(cacheKey);
      cacheInvalidated = true;
    } catch (redisErr) {
      console.warn("[PricingService] Redis DEL error during cache invalidation:", redisErr?.message);
    }

    const rule = {
      id: data.id,
      modelKey: data.model_key,
      operationType: data.operation_type,
      qualityTier: data.quality_tier,
      creditCost: Number(data.credit_cost),
      isActive: data.is_active,
      updatedAt: new Date().toISOString(),
    };

    return { rule, cacheInvalidated };
  }

  /** @private */
  _cacheKey(modelKey, operationType, qualityTier) {
    return `pricing:${modelKey}:${operationType}:${qualityTier}`;
  }
}
