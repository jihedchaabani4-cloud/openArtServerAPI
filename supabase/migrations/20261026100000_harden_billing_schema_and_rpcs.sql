-- Migration: 20261026100000_harden_billing_schema_and_rpcs.sql
-- Description:
--   P0-1: Allow NULL transactions.expires_at so credit_wallet (CREDIT rows) succeeds cleanly.
--   P0-3: Create missing public.failed_wallet_operations table with RLS, service_role lockdown, and retry index.
--   P1-6: Add idx_transactions_wallet_id, enable RLS on public.transactions, harden all 4 baseline
--         wallet RPCs (credit_wallet, hold_credits, commit_transaction, rollback_transaction) with
--         SECURITY DEFINER + search_path + service_role least privilege, and add atomic p_extra_metadata
--         merge to commit_transaction / rollback_transaction (dropping legacy 1-arg overloads cleanly).
--   P1-1: Add single-hop hold_credits_for_user RPC resolving wallet by p_user_id atomically.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. P0-1: Credits do not expire; only DEBIT HOLD rows require expires_at
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.transactions
    ALTER COLUMN expires_at DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. P0-3: Create public.failed_wallet_operations (matching FailedOpsRepository)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.failed_wallet_operations (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_type  text        NOT NULL CHECK (operation_type IN ('COMMIT', 'ROLLBACK', 'CREDIT', 'DEBIT')),
    reference_id    text        NOT NULL,
    wallet_id       uuid        REFERENCES public.wallets(id) ON DELETE SET NULL,
    user_id         uuid        NOT NULL,
    amount          numeric,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    failure_reason  text,
    retry_count     integer     NOT NULL DEFAULT 0,
    max_retries     integer     NOT NULL DEFAULT 5,
    status          text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'ABANDONED')),
    next_retry_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_failed_wallet_operations_status_next_retry
    ON public.failed_wallet_operations (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_failed_wallet_operations_reference_op
    ON public.failed_wallet_operations (reference_id, operation_type);

DROP TRIGGER IF EXISTS update_failed_wallet_operations_updated_at ON public.failed_wallet_operations;
CREATE TRIGGER update_failed_wallet_operations_updated_at
    BEFORE UPDATE ON public.failed_wallet_operations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.failed_wallet_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.failed_wallet_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.failed_wallet_operations TO service_role;

DROP POLICY IF EXISTS "Service role can manage failed wallet operations" ON public.failed_wallet_operations;
CREATE POLICY "Service role can manage failed wallet operations"
    ON public.failed_wallet_operations
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. P1-6: transactions wallet_id index & Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id
    ON public.transactions (wallet_id);

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage transactions" ON public.transactions;
CREATE POLICY "Service role can manage transactions"
    ON public.transactions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view their own transactions" ON public.transactions;
CREATE POLICY "Users can view their own transactions"
    ON public.transactions
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.wallets w
            WHERE w.id = transactions.wallet_id
              AND w.user_id = auth.uid()
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. P1-6: Hardened credit_wallet RPC (SECURITY DEFINER + least privilege)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_wallet(
    p_wallet_id    uuid,
    p_amount       numeric,
    p_reference_id text,
    p_metadata     jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows_updated integer;
    v_transaction  record;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Credit amount must be positive (got %)', p_amount;
    END IF;

    -- 1. Check duplicate reference_id
    IF EXISTS (SELECT 1 FROM public.transactions WHERE reference_id = p_reference_id) THEN
        RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
    END IF;

    -- 2. Atomically credit wallet balance
    UPDATE public.wallets
    SET balance = balance + p_amount,
        updated_at = now()
    WHERE id = p_wallet_id;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    IF v_rows_updated != 1 THEN
        RAISE EXCEPTION 'Wallet % not found', p_wallet_id;
    END IF;

    -- 3. Insert completed CREDIT transaction (expires_at is NULL for credits)
    INSERT INTO public.transactions (
        wallet_id, amount, type, status, reference_id, metadata, expires_at
    ) VALUES (
        p_wallet_id, p_amount, 'CREDIT', 'COMPLETED', p_reference_id, COALESCE(p_metadata, '{}'::jsonb), NULL
    ) RETURNING * INTO v_transaction;

    RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_wallet(uuid, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(uuid, numeric, text, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. P1-6: Hardened hold_credits RPC (SECURITY DEFINER + least privilege)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hold_credits(
    p_wallet_id    uuid,
    p_amount       numeric,
    p_reference_id text,
    p_metadata     jsonb,
    p_expires_at   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_balance     numeric;
    v_transaction record;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Hold amount must be positive (got %)', p_amount;
    END IF;

    -- 1. Check if transaction already exists
    IF EXISTS (SELECT 1 FROM public.transactions WHERE reference_id = p_reference_id) THEN
        RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
    END IF;

    -- 2. Lock the wallet row and get balance
    SELECT balance INTO v_balance FROM public.wallets WHERE id = p_wallet_id FOR UPDATE;

    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'Wallet % not found', p_wallet_id;
    END IF;

    IF v_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds: need %, have %', p_amount, v_balance;
    END IF;

    -- 3. Deduct balance
    UPDATE public.wallets
    SET balance = balance - p_amount,
        updated_at = now()
    WHERE id = p_wallet_id;

    -- 4. Create pending DEBIT transaction
    INSERT INTO public.transactions (
        wallet_id, amount, type, status, reference_id, metadata, expires_at
    ) VALUES (
        p_wallet_id,
        p_amount,
        'DEBIT',
        'PENDING',
        p_reference_id,
        COALESCE(p_metadata, '{}'::jsonb),
        COALESCE(p_expires_at, now() + interval '10 minutes')
    ) RETURNING * INTO v_transaction;

    RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.hold_credits(uuid, numeric, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_credits(uuid, numeric, text, jsonb, timestamptz) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. P1-1: Single-hop hold_credits_for_user RPC (resolves wallet by p_user_id)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hold_credits_for_user(
    p_user_id      uuid,
    p_amount       numeric,
    p_reference_id text,
    p_metadata     jsonb DEFAULT '{}'::jsonb,
    p_expires_at   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wallet_id   uuid;
    v_balance     numeric;
    v_transaction record;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Hold amount must be positive (got %)', p_amount;
    END IF;

    -- 1. Check duplicate reference_id
    IF EXISTS (SELECT 1 FROM public.transactions WHERE reference_id = p_reference_id) THEN
        RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
    END IF;

    -- 2. Resolve and lock wallet row by user_id in a single DB round-trip
    SELECT id, balance INTO v_wallet_id, v_balance
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
    END IF;

    IF v_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds: need %, have %', p_amount, v_balance;
    END IF;

    -- 3. Deduct balance atomically
    UPDATE public.wallets
    SET balance = balance - p_amount,
        updated_at = now()
    WHERE id = v_wallet_id;

    -- 4. Insert pending DEBIT hold
    INSERT INTO public.transactions (
        wallet_id, amount, type, status, reference_id, metadata, expires_at
    ) VALUES (
        v_wallet_id,
        p_amount,
        'DEBIT',
        'PENDING',
        p_reference_id,
        COALESCE(p_metadata, '{}'::jsonb),
        COALESCE(p_expires_at, now() + interval '10 minutes')
    ) RETURNING * INTO v_transaction;

    RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.hold_credits_for_user(uuid, numeric, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_credits_for_user(uuid, numeric, text, jsonb, timestamptz) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. P1-6: Atomic metadata merge in commit_transaction (drop 1-arg overload)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.commit_transaction(text);

CREATE OR REPLACE FUNCTION public.commit_transaction(
    p_reference_id   text,
    p_extra_metadata jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_transaction record;
BEGIN
    SELECT * INTO v_transaction
    FROM public.transactions
    WHERE reference_id = p_reference_id
    FOR UPDATE;

    IF v_transaction IS NULL THEN
        RAISE EXCEPTION 'Transaction % not found', p_reference_id;
    END IF;

    IF v_transaction.status != 'PENDING' THEN
        RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
    END IF;

    UPDATE public.transactions
    SET status = 'COMPLETED',
        metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_extra_metadata, '{}'::jsonb),
        updated_at = now()
    WHERE id = v_transaction.id
    RETURNING * INTO v_transaction;

    RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_transaction(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_transaction(text, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. P1-6: Atomic metadata merge in rollback_transaction (drop 1-arg overload)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.rollback_transaction(text);

CREATE OR REPLACE FUNCTION public.rollback_transaction(
    p_reference_id   text,
    p_extra_metadata jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_transaction record;
BEGIN
    SELECT * INTO v_transaction
    FROM public.transactions
    WHERE reference_id = p_reference_id
    FOR UPDATE;

    IF v_transaction IS NULL THEN
        RAISE EXCEPTION 'Transaction % not found', p_reference_id;
    END IF;

    IF v_transaction.status != 'PENDING' THEN
        RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
    END IF;

    -- Refund the wallet atomically
    UPDATE public.wallets
    SET balance = balance + v_transaction.amount,
        updated_at = now()
    WHERE id = v_transaction.wallet_id;

    -- Mark as FAILED and merge optional metadata atomically
    UPDATE public.transactions
    SET status = 'FAILED',
        metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_extra_metadata, '{}'::jsonb),
        updated_at = now()
    WHERE id = v_transaction.id
    RETURNING * INTO v_transaction;

    RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_transaction(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_transaction(text, jsonb) TO service_role;
