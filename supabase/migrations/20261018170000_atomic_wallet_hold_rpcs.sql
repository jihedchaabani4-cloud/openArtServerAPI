-- Migration: 20261018170000_atomic_wallet_hold_rpcs.sql
-- Description: Define hardened atomic wallet hold RPCs: extend_hold and expire_stale_holds.
--              Eliminates non-atomic Node.js fallback, prevents lost updates on wallet balances,
--              enforces strict row-count verification and per-row subtransaction savepoints to prevent poison-pill blocking,
--              restricts execution to service_role only (least privilege), filters strictly on type = 'DEBIT',
--              bounds sweep batch size to prevent statement timeouts, and strictly enforces expiration boundaries.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. SAFE TIMESTAMPTZ CAST HELPER
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.try_cast_timestamptz(p_val text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_val IS NULL OR TRIM(p_val) = '' THEN
        RETURN NULL;
    END IF;
    RETURN p_val::timestamptz;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.try_cast_timestamptz(text) IS
'Safely casts text to timestamptz. Returns NULL on null, empty, or invalid timestamp strings without raising an exception.';

REVOKE ALL ON FUNCTION public.try_cast_timestamptz(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_cast_timestamptz(text) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 0B. OVERFLOW-SAFE SWEEP ATTEMPTS PARSER
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.parse_sweep_attempts(p_val text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_trimmed text;
    v_norm text;
    v_len integer;
BEGIN
    IF p_val IS NULL THEN
        RETURN 0;
    END IF;

    v_trimmed := TRIM(p_val);
    IF v_trimmed = '' THEN
        RETURN 0;
    END IF;

    -- Explicit validation: input must consist solely of 1 or more ASCII digits
    IF NOT (v_trimmed ~ '^\d+$') THEN
        RETURN 0;
    END IF;

    -- Normalize leading zeros (e.g. '0000000002' -> '2', '0000' -> '0')
    v_norm := LTRIM(v_trimmed, '0');
    IF v_norm = '' THEN
        RETURN 0;
    END IF;

    v_len := length(v_norm);

    -- Strictly nested validation without any numeric conversion:
    -- If length > 10, value is >= 10,000,000,000, which exceeds signed 32-bit int max (2,147,483,647).
    -- If length = 10 and string is lexicographically greater than '2147483647', it also overflows signed 32-bit int.
    -- Return 2147483647 directly without casting, avoiding any integer or numeric overflow.
    IF v_len > 10 OR (v_len = 10 AND v_norm > '2147483647') THEN
        RETURN 2147483647;
    END IF;

    -- At this point, v_norm is strictly 1 to 10 digits and <= 2147483647.
    -- The cast is mathematically guaranteed not to overflow a signed 32-bit integer.
    RETURN v_norm::integer;
EXCEPTION
    WHEN OTHERS THEN
        RETURN 0;
END;
$$;

COMMENT ON FUNCTION public.parse_sweep_attempts(text) IS
'Safely parses text to integer attempt count. Returns 0 on NULL or non-numeric, 2147483647 on overflow, without raising an exception.';

REVOKE ALL ON FUNCTION public.parse_sweep_attempts(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parse_sweep_attempts(text) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EXTEND HOLD (HEARTBEAT TTL EXTENSION)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.extend_hold(
    p_reference_id text,
    p_additional_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_transaction record;
    v_seconds integer;
BEGIN
    -- 1. Input validation
    IF p_reference_id IS NULL OR TRIM(p_reference_id) = '' THEN
        RAISE EXCEPTION 'p_reference_id cannot be null or empty';
    END IF;

    v_seconds := COALESCE(p_additional_seconds, 300);
    IF v_seconds <= 0 THEN
        RAISE EXCEPTION 'p_additional_seconds must be a positive integer';
    END IF;

    IF v_seconds > 3600 THEN
        RAISE EXCEPTION 'p_additional_seconds cannot exceed 3600 seconds (1 hour)';
    END IF;

    -- 2. Lock the transaction row with STRICT to guarantee unambiguous single-row match
    BEGIN
        SELECT * INTO STRICT v_transaction 
        FROM public.transactions 
        WHERE reference_id = p_reference_id 
        FOR UPDATE;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RAISE EXCEPTION 'Transaction % not found', p_reference_id;
        WHEN TOO_MANY_ROWS THEN
            RAISE EXCEPTION 'Ambiguous transaction match: multiple records found for reference_id %', p_reference_id;
    END;

    -- 3. Assert transaction is a DEBIT hold
    IF v_transaction.type != 'DEBIT' THEN
        RAISE EXCEPTION 'Cannot extend transaction % with type % (expected DEBIT)', p_reference_id, v_transaction.type;
    END IF;

    -- 4. Assert transaction is still PENDING
    IF v_transaction.status != 'PENDING' THEN
        RAISE EXCEPTION 'Cannot extend transaction with status %', v_transaction.status;
    END IF;

    -- 5. Reject quarantined transactions
    IF (v_transaction.metadata->>'quarantined') = 'true' THEN
        RAISE EXCEPTION 'Cannot extend quarantined transaction %', p_reference_id;
    END IF;

    -- 6. Explicitly assert expires_at nullability and boundary: reject already-expired holds
    IF v_transaction.expires_at IS NULL THEN
        RAISE EXCEPTION 'Transaction % has null expires_at', p_reference_id;
    END IF;

    IF v_transaction.expires_at <= now() THEN
        RAISE EXCEPTION 'Cannot extend expired transaction % (expired at %)', p_reference_id, v_transaction.expires_at;
    END IF;

    -- 7. Atomically extend expires_at from existing unexpired expires_at
    UPDATE public.transactions
    SET expires_at = v_transaction.expires_at + (v_seconds || ' seconds')::interval,
        updated_at = now()
    WHERE id = v_transaction.id
    RETURNING * INTO v_transaction;

    -- 8. Post-update invariant check: ensure function cannot return success without a valid future expiry
    IF v_transaction.expires_at IS NULL OR v_transaction.expires_at <= now() THEN
        RAISE EXCEPTION 'Failed to extend transaction %: invalid resultant expiry %', p_reference_id, v_transaction.expires_at;
    END IF;

    -- 9. Return only required backend fields (no internal leakage)
    RETURN jsonb_build_object(
        'id', v_transaction.id,
        'reference_id', v_transaction.reference_id,
        'wallet_id', v_transaction.wallet_id,
        'amount', v_transaction.amount,
        'status', v_transaction.status,
        'expires_at', v_transaction.expires_at,
        'updated_at', v_transaction.updated_at
    );
END;
$$;

COMMENT ON FUNCTION public.extend_hold(text, integer) IS 
'Atomically extends the expires_at TTL of an active, unexpired PENDING credit reservation. Rejects expired, finalized, quarantined, non-debit, or ambiguous transactions.';

-- Least Privilege: Revoke from all public/client roles, grant strictly to service_role
REVOKE ALL ON FUNCTION public.extend_hold(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_hold(text, integer) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. EXPIRE STALE HOLDS (ATOMIC CLAIM, BOUNDED SWEEP, RETRY BACKOFF & QUARANTINE)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expire_stale_holds(
    p_batch_size integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tx record;
    v_rows_updated integer;
    v_batch_limit integer;
    v_expired_records jsonb := '[]'::jsonb;
BEGIN
    -- Bound batch limit to prevent statement timeouts or oversized PostgREST payloads
    v_batch_limit := COALESCE(p_batch_size, 100);
    IF v_batch_limit <= 0 THEN
        v_batch_limit := 100;
    ELSIF v_batch_limit > 1000 THEN
        v_batch_limit := 1000;
    END IF;

    -- Lock and claim expired PENDING DEBIT holds in deterministic order to prevent deadlocks.
    -- Filtering strictly by type = 'DEBIT' ensures pending top-ups or credits are never accidentally refunded.
    -- Quarantined holds (quarantined = true) and holds currently under retry backoff are skipped
    -- so that repeatedly failing rows cannot starve valid holds sorting later.
    -- SKIP LOCKED prevents concurrent reaper workers from blocking each other or double-claiming.
    FOR v_tx IN
        SELECT * FROM public.transactions
        WHERE type = 'DEBIT'
          AND status = 'PENDING'
          AND expires_at IS NOT NULL
          AND expires_at < now()
          AND (metadata->>'quarantined' IS NULL OR (metadata->>'quarantined') != 'true')
          AND (
              public.try_cast_timestamptz(metadata->>'sweep_retry_after') IS NULL
              OR public.try_cast_timestamptz(metadata->>'sweep_retry_after') <= now()
          )
        ORDER BY wallet_id ASC, id ASC
        LIMIT v_batch_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        -- Per-row subtransaction: isolates each hold to prevent a single malformed row from poisoning the whole batch
        BEGIN
            -- 1. Refund the wallet balance atomically
            UPDATE public.wallets
            SET balance = balance + v_tx.amount,
                updated_at = now()
            WHERE id = v_tx.wallet_id;

            -- Verify that exactly one wallet row was updated
            GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
            IF v_rows_updated != 1 THEN
                RAISE EXCEPTION 'Failed to refund wallet % for transaction %: affected % rows',
                    v_tx.wallet_id, v_tx.id, v_rows_updated;
            END IF;

            -- 2. Transition transaction status to FAILED (only when refund has strictly succeeded)
            UPDATE public.transactions
            SET status = 'FAILED',
                updated_at = now()
            WHERE id = v_tx.id
            RETURNING * INTO v_tx;

            GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
            IF v_rows_updated != 1 THEN
                RAISE EXCEPTION 'Failed to update status to FAILED for transaction %: affected % rows',
                    v_tx.id, v_rows_updated;
            END IF;

            -- 3. Accumulate minimal required fields into result array
            v_expired_records := v_expired_records || jsonb_build_array(
                jsonb_build_object(
                    'id', v_tx.id,
                    'reference_id', v_tx.reference_id,
                    'wallet_id', v_tx.wallet_id,
                    'amount', v_tx.amount,
                    'status', v_tx.status,
                    'metadata', v_tx.metadata
                )
            );
        EXCEPTION
            WHEN OTHERS THEN
                -- The refund subtransaction rolled back.
                -- Subtransaction isolation preserves wallet funds: transaction status remains PENDING.
                -- We now record error metadata, increment attempt counter, and apply retry backoff / quarantine
                -- to prevent this failing record from starving valid records on subsequent sweeps.
                -- If the hold arrived with malformed retry metadata, record the original invalid value for observability.
                DECLARE
                    v_err text := SQLERRM;
                    v_raw_attempts text := v_tx.metadata->>'sweep_attempts';
                    v_prev_attempts integer;
                    v_attempts integer;
                    v_max_attempts constant integer := 3;
                    v_is_quarantined boolean;
                    v_next_retry timestamptz;
                    v_failure_meta jsonb;
                BEGIN
                    -- Safely parse previous attempts without 32-bit integer overflow risk
                    v_prev_attempts := public.parse_sweep_attempts(v_raw_attempts);

                    IF v_prev_attempts >= (v_max_attempts - 1) THEN
                        v_attempts := v_max_attempts;
                        v_is_quarantined := true;
                        v_next_retry := NULL;
                    ELSE
                        v_attempts := v_prev_attempts + 1;
                        v_is_quarantined := false;
                        v_next_retry := now() + (v_attempts * 60 || ' seconds')::interval;
                    END IF;

                    v_failure_meta := jsonb_build_object(
                        'last_sweep_error', v_err,
                        'last_sweep_attempt_at', now(),
                        'sweep_attempts', v_attempts,
                        'sweep_retry_after', v_next_retry,
                        'quarantined', v_is_quarantined,
                        'quarantine_reason', CASE WHEN v_is_quarantined THEN v_err ELSE NULL END,
                        'quarantined_at', CASE WHEN v_is_quarantined THEN now() ELSE NULL END
                    );

                    -- Check if transaction arrived with malformed retry metadata
                    IF v_tx.metadata->>'sweep_retry_after' IS NOT NULL 
                       AND public.try_cast_timestamptz(v_tx.metadata->>'sweep_retry_after') IS NULL THEN
                        v_failure_meta := v_failure_meta || jsonb_build_object(
                            'malformed_retry_after_received', v_tx.metadata->>'sweep_retry_after'
                        );
                    END IF;

                    -- Check if transaction arrived with non-numeric or oversized sweep_attempts using pure string checks
                    IF v_raw_attempts IS NOT NULL AND TRIM(v_raw_attempts) != '' THEN
                        DECLARE
                            v_raw_trim text := TRIM(v_raw_attempts);
                            v_raw_norm text;
                            v_raw_len integer;
                            v_is_malformed boolean := false;
                        BEGIN
                            IF NOT (v_raw_trim ~ '^\d+$') THEN
                                v_is_malformed := true;
                            ELSE
                                v_raw_norm := LTRIM(v_raw_trim, '0');
                                v_raw_len := length(v_raw_norm);
                                IF v_raw_len > 10 OR (v_raw_len = 10 AND v_raw_norm > '2147483647') THEN
                                    v_is_malformed := true;
                                END IF;
                            END IF;

                            IF v_is_malformed THEN
                                v_failure_meta := v_failure_meta || jsonb_build_object(
                                    'malformed_attempts_received',
                                    CASE 
                                        WHEN length(v_raw_attempts) > 100 
                                        THEN SUBSTRING(v_raw_attempts FROM 1 FOR 97) || '...'
                                        ELSE v_raw_attempts 
                                    END
                                );
                            END IF;
                        END;
                    END IF;

                    UPDATE public.transactions
                    SET metadata = COALESCE(metadata, '{}'::jsonb) || v_failure_meta,
                        updated_at = now()
                    WHERE id = v_tx.id;

                    RAISE WARNING 'expire_stale_holds: hold % (wallet %) attempt % failed: % (quarantined: %)',
                        v_tx.id, v_tx.wallet_id, v_attempts, v_err, v_is_quarantined;
                EXCEPTION
                    WHEN OTHERS THEN
                        RAISE WARNING 'expire_stale_holds: could not update failure metadata for %: %',
                            v_tx.id, SQLERRM;
                END;
        END;
    END LOOP;

    RETURN v_expired_records;
END;
$$;

COMMENT ON FUNCTION public.expire_stale_holds(integer) IS 
'Atomically sweeps expired PENDING DEBIT holds up to batch_size, refunds user wallets with strict row-count verification, subtransaction error isolation, and retry backoff / quarantine to prevent starvation.';

-- Least Privilege: Revoke from all public/client roles, grant strictly to service_role
REVOKE ALL ON FUNCTION public.expire_stale_holds(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_holds(integer) TO service_role;
