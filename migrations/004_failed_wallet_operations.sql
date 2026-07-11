-- Migration 004: Failed Wallet Operations Table
-- ─────────────────────────────────────────────────────────────────────────────
-- Persistent record of wallet operations (commit / rollback / credit / debit)
-- that failed due to transient errors and need automatic retry.
--
-- The walletWorker 'retry-failed-ops' job polls this table every 5 minutes and
-- replays each pending operation with exponential backoff:
--   next_retry_at = NOW() + interval '1 minute' * 2^retry_count
-- After max_retries attempts, status → 'ABANDONED' and a structured error is logged.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS failed_wallet_operations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What kind of wallet operation failed
  operation_type  TEXT        NOT NULL
                              CHECK (operation_type IN ('COMMIT', 'ROLLBACK', 'CREDIT', 'DEBIT')),

  -- The reference ID from the original transaction (mirrors transactions.reference_id)
  reference_id    TEXT        NOT NULL,

  -- Wallet and user context (nullable if wallet was not yet resolved at failure time)
  wallet_id       UUID        REFERENCES wallets(id) ON DELETE SET NULL,
  user_id         UUID        NOT NULL,
  amount          NUMERIC,

  -- Full operation parameters — enough to replay the operation without extra lookups
  payload         JSONB       NOT NULL DEFAULT '{}',

  -- Retry tracking
  failure_reason  TEXT,
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  max_retries     INTEGER     NOT NULL DEFAULT 5,
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'COMPLETED', 'ABANDONED')),
  next_retry_at   TIMESTAMPTZ,          -- NULL = retry immediately on next job run

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optimised for the retry worker's primary query:
-- WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
CREATE INDEX IF NOT EXISTS idx_fwo_pending
  ON failed_wallet_operations (status, next_retry_at)
  WHERE status = 'PENDING';

-- Lookup by reference_id (to check for existing records before inserting)
CREATE INDEX IF NOT EXISTS idx_fwo_reference_id
  ON failed_wallet_operations (reference_id);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_fwo_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fwo_updated_at ON failed_wallet_operations;
CREATE TRIGGER trg_fwo_updated_at
  BEFORE UPDATE ON failed_wallet_operations
  FOR EACH ROW EXECUTE FUNCTION update_fwo_updated_at();
