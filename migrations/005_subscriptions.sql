-- Migration 005: Subscriptions Table (Schema Only — P3)
-- ─────────────────────────────────────────────────────────────────────────────
-- Schema created in this feature cycle so that future P3 subscription logic
-- can be added without a blocking migration.
-- Application logic (monthly credit allocation, renewal, cancellation) is
-- NOT implemented in this feature — deferred to a dedicated subscriptions feature.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_type             TEXT        NOT NULL,  -- e.g. 'basic', 'pro', 'enterprise'
  monthly_credit_amount NUMERIC     NOT NULL CHECK (monthly_credit_amount > 0),
  next_billing_at       TIMESTAMPTZ NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'ACTIVE'
                                    CHECK (status IN ('ACTIVE', 'CANCELLED', 'PAST_DUE')),
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by status for billing jobs (P3)
CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON subscriptions (status, next_billing_at)
  WHERE status = 'ACTIVE';
