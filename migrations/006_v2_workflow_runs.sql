-- Migration 006: V2 Workflow Runs and Node Runs
-- ─────────────────────────────────────────────────────────────────────────────
-- Stores states, inputs, outputs, error details, and serialized execution plans
-- for the V2 Composable Workflow Engine runs.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS v2_workflow_runs (
  run_id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      TEXT         NOT NULL,
  workflow_version TEXT         NOT NULL,
  user_id          UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  status           TEXT         NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  input            JSONB        NOT NULL,
  execution_plan   JSONB        NOT NULL,
  outputs          JSONB,
  error            JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS v2_workflow_run_nodes (
  run_id            UUID         NOT NULL REFERENCES v2_workflow_runs(run_id) ON DELETE CASCADE,
  node_id           TEXT         NOT NULL,
  node_type         TEXT         NOT NULL,
  status            TEXT         NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempt           INT          NOT NULL DEFAULT 1,
  provider_override TEXT,
  output            JSONB,
  error             JSONB,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  PRIMARY KEY (run_id, node_id)
);

-- Indexes for performance and lookup
CREATE INDEX IF NOT EXISTS idx_v2_workflow_runs_user_created 
  ON v2_workflow_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_v2_workflow_runs_status
  ON v2_workflow_runs (run_id, status);
