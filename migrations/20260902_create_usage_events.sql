-- ============================================================
-- Migration: 20260902_create_usage_events
-- Purpose: Audit trail for free/zero-cost model usage.
--          Intentionally SEPARATE from the financial `transactions`
--          ledger — preserves the CHECK (amount > 0) constraint
--          on transactions and keeps revenue reports clean.
-- ============================================================

CREATE TABLE IF NOT EXISTS usage_events (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reference_id TEXT         UNIQUE NOT NULL,
    kind         TEXT         NOT NULL DEFAULT 'free_model_usage',
    -- ACTIVE → COMPLETED (success) | RELEASED (cancelled/failure)
    status       TEXT         NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE', 'COMPLETED', 'RELEASED')),
    metadata     JSONB        DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for the most common query patterns
CREATE INDEX IF NOT EXISTS idx_usage_events_user_id      ON usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_reference_id ON usage_events(reference_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_status       ON usage_events(status);
CREATE INDEX IF NOT EXISTS idx_usage_events_created_at   ON usage_events(created_at DESC);

-- ── Row Level Security ─────────────────────────────────────────────────────────
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- Users can only read their own usage events
CREATE POLICY "usage_events_select_own"
  ON usage_events FOR SELECT
  USING (auth.uid() = user_id);

-- Service role bypasses RLS (used by WalletService server-side)
-- (Supabase service role key already bypasses RLS by default)

-- ── Updated-at trigger ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_usage_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_usage_events_updated_at
  BEFORE UPDATE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION update_usage_events_updated_at();
