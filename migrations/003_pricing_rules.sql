-- Migration 003: Pricing Rules Table
-- ─────────────────────────────────────────────────────────────────────────────
-- Stores credit cost configuration per model / operation / quality combination.
-- Redis cache layer (key: pricing:{model_key}:{operation_type}:{quality_tier},
-- TTL 300s) is maintained by PricingService.js — DB is always the source of truth.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pricing_rules (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key       TEXT        NOT NULL,
  operation_type  TEXT        NOT NULL
                              CHECK (operation_type IN (
                                'IMAGE_GENERATION',
                                'VIDEO_GENERATION',
                                'IMAGE_EDIT',
                                'UPSCALE'
                              )),
  quality_tier    TEXT        NOT NULL
                              CHECK (quality_tier IN ('standard', 'hd', '4k')),
  credit_cost     NUMERIC     NOT NULL CHECK (credit_cost > 0),
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,          -- NULL = no expiry
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active price per (model, operation, quality) combination
ALTER TABLE pricing_rules
  ADD CONSTRAINT uq_pricing_active
  UNIQUE (model_key, operation_type, quality_tier);

-- Fast lookup by active rules (used on every generation price check)
CREATE INDEX IF NOT EXISTS idx_pricing_active
  ON pricing_rules (model_key, operation_type, quality_tier)
  WHERE is_active = TRUE;

-- ─── Seed: default pricing for common models ──────────────────────────────────
-- Adjust credit_cost values to match your business pricing.
INSERT INTO pricing_rules (model_key, operation_type, quality_tier, credit_cost) VALUES
  ('gpt-image-1',   'IMAGE_GENERATION', 'standard', 10),
  ('gpt-image-1',   'IMAGE_GENERATION', 'hd',       20),
  ('gpt-image-1',   'IMAGE_EDIT',       'standard', 10),
  ('gpt-image-1',   'IMAGE_EDIT',       'hd',       20),
  ('kling-v1',      'VIDEO_GENERATION', 'standard', 50),
  ('kling-v1',      'VIDEO_GENERATION', 'hd',       100),
  ('kling-v2',      'VIDEO_GENERATION', 'standard', 60),
  ('kling-v2',      'VIDEO_GENERATION', 'hd',       120),
  ('fal-upscale',   'UPSCALE',          'standard', 5)
ON CONFLICT (model_key, operation_type, quality_tier) DO NOTHING;
