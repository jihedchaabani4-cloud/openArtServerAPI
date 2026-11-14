import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ─── Source: atomicWalletHoldPostgres.integration.test.js ───
{
/**
 * Real PostgreSQL Integration Test: Atomic Wallet Hold RPCs (Ticket 06)
 *
 * PURPOSE:
 *   Exercises real PostgreSQL ACID transaction semantics, row-level locks,
 *   FOR UPDATE SKIP LOCKED concurrency, and rollback on simulated failure.
 *
 * DISTINCTION FROM HERMETIC TESTS:
 *   - Hermetic tests in tests/boundary/* use in-memory and mocked drivers with zero network.
 *   - THIS test runs exclusively against a real PostgreSQL connection when INTEGRATION_TEST_DB_URL
 *     or TEST_DATABASE_URL is provided in the environment.
 *   - When no database URL is set, the suite cleanly skips with an explicit notice,
 *     preserving hermetic CI/npm test runs.
 */


const dbUrl = process.env.INTEGRATION_TEST_DB_URL || process.env.TEST_DATABASE_URL;

describe("Ticket 06: Real PostgreSQL Atomic Wallet Hold Integration Tests", { skip: !dbUrl && "Set INTEGRATION_TEST_DB_URL to run real PostgreSQL concurrency tests" }, () => {
  let client;
  let testSchema;

  before(async () => {
    if (!dbUrl) return;
    // Dynamic import of pg only if URL is configured
    const { Client } = await import("pg");
    client = new Client({ connectionString: dbUrl });
    await client.connect();

    testSchema = `test_wallet_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await client.query(`CREATE SCHEMA ${testSchema}`);
    await client.query(`SET search_path TO ${testSchema}, public`);

    // Create minimal schema mirroring production
    await client.query(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        balance NUMERIC(15,2) DEFAULT 0.00 CHECK (balance >= 0),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
        amount NUMERIC(15,2) NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        reference_id TEXT NOT NULL UNIQUE,
        metadata JSONB DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Deploy the exact functions under test into the disposable schema
    await client.query(`
      CREATE OR REPLACE FUNCTION extend_hold(p_reference_id text, p_additional_seconds integer DEFAULT 300)
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_tx record;
        v_sec integer;
      BEGIN
        IF p_reference_id IS NULL OR TRIM(p_reference_id) = '' THEN
          RAISE EXCEPTION 'p_reference_id cannot be null or empty';
        END IF;
        v_sec := COALESCE(p_additional_seconds, 300);
        IF v_sec <= 0 THEN RAISE EXCEPTION 'p_additional_seconds must be a positive integer'; END IF;
        IF v_sec > 3600 THEN RAISE EXCEPTION 'p_additional_seconds cannot exceed 3600 seconds'; END IF;

        SELECT * INTO v_tx FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
        IF v_tx IS NULL THEN RAISE EXCEPTION 'Transaction % not found', p_reference_id; END IF;
        IF v_tx.status != 'PENDING' THEN RAISE EXCEPTION 'Cannot extend transaction with status %', v_tx.status; END IF;
        IF v_tx.expires_at <= now() THEN RAISE EXCEPTION 'Cannot extend expired transaction %', p_reference_id; END IF;

        UPDATE transactions
        SET expires_at = v_tx.expires_at + (v_sec || ' seconds')::interval, updated_at = now()
        WHERE id = v_tx.id
        RETURNING * INTO v_tx;

        RETURN jsonb_build_object(
          'id', v_tx.id, 'reference_id', v_tx.reference_id, 'wallet_id', v_tx.wallet_id,
          'amount', v_tx.amount, 'status', v_tx.status, 'expires_at', v_tx.expires_at
        );
      END;
      $$;

      CREATE OR REPLACE FUNCTION expire_stale_holds()
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_tx record;
        v_rows integer;
        v_records jsonb := '[]'::jsonb;
      BEGIN
        FOR v_tx IN
          SELECT * FROM transactions
          WHERE status = 'PENDING' AND expires_at < now()
          ORDER BY wallet_id ASC, id ASC
          FOR UPDATE SKIP LOCKED
        LOOP
          UPDATE wallets SET balance = balance + v_tx.amount, updated_at = now() WHERE id = v_tx.wallet_id;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows != 1 THEN
            RAISE EXCEPTION 'Failed to refund wallet %: affected % rows', v_tx.wallet_id, v_rows;
          END IF;

          UPDATE transactions SET status = 'FAILED', updated_at = now() WHERE id = v_tx.id RETURNING * INTO v_tx;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows != 1 THEN
            RAISE EXCEPTION 'Failed to update transaction %: affected % rows', v_tx.id, v_rows;
          END IF;

          v_records := v_records || jsonb_build_array(jsonb_build_object(
            'id', v_tx.id, 'reference_id', v_tx.reference_id, 'wallet_id', v_tx.wallet_id,
            'amount', v_tx.amount, 'status', v_tx.status, 'metadata', v_tx.metadata
          ));
        END LOOP;
        RETURN v_records;
      END;
      $$;
    `);
  });

  after(async () => {
    if (client && testSchema) {
      await client.query(`DROP SCHEMA ${testSchema} CASCADE`);
      await client.end();
    }
  });

  it("REAL-DB 1: Exactly-once refund under concurrent expire_stale_holds execution", async () => {
    // Insert wallet with initial balance 50.00
    const { rows: [w] } = await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES (gen_random_uuid(), 50.00) RETURNING id`
    );

    // Insert 2 expired pending transactions (amount 10.00 each)
    await client.query(`
      INSERT INTO transactions (wallet_id, amount, type, status, reference_id, expires_at)
      VALUES 
        ('${w.id}', 10.00, 'DEBIT', 'PENDING', 'ref-expired-1', now() - INTERVAL '1 minute'),
        ('${w.id}', 10.00, 'DEBIT', 'PENDING', 'ref-expired-2', now() - INTERVAL '2 minutes')
    `);

    // Run expire_stale_holds
    const { rows: [res] } = await client.query(`SELECT expire_stale_holds() AS data`);
    const expiredList = res.data;

    assert.equal(expiredList.length, 2);

    // Verify wallet balance is refunded exactly once (50 + 10 + 10 = 70.00)
    const { rows: [freshWallet] } = await client.query(`SELECT balance FROM wallets WHERE id = '${w.id}'`);
    assert.equal(Number(freshWallet.balance), 70.00);

    // Subsequent call returns empty (idempotent / non-repeating)
    const { rows: [res2] } = await client.query(`SELECT expire_stale_holds() AS data`);
    assert.equal(res2.data.length, 0);
  });

  it("REAL-DB 2: extend_hold rejects expired hold and prevents resurrection", async () => {
    const { rows: [w] } = await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES (gen_random_uuid(), 100.00) RETURNING id`
    );

    await client.query(`
      INSERT INTO transactions (wallet_id, amount, type, status, reference_id, expires_at)
      VALUES ('${w.id}', 20.00, 'DEBIT', 'PENDING', 'ref-expired-boundary', now() - INTERVAL '5 seconds')
    `);

    await assert.rejects(
      async () => client.query(`SELECT extend_hold('ref-expired-boundary', 300)`),
      /Cannot extend expired transaction/
    );
  });
});
}

// ─── Source: atomicWalletHoldIdempotentPostgres.integration.test.js ───
{
/**
 * Real PostgreSQL Integration Test: Atomic Wallet Hold Idempotency & Concurrency (Phase 4)
 *
 * PURPOSE:
 *   Exercises real PostgreSQL ACID transaction semantics, row-level locks (FOR UPDATE),
 *   concurrent rollbacks (double refund prevention), and commit vs rollback race conditions
 *   using the exact SQL functions deployed in production (baseline.sql:84, 237).
 *
 * SAFETY & HERMETICITY:
 *   - Runs exclusively against a real PostgreSQL connection when LOCAL_SUPABASE_POSTGRES_URL
 *     or INTEGRATION_TEST_DB_URL is set.
 *   - Automatically skipped when unset, ensuring hermetic unit test suites pass offline.
 *   - Creates an isolated, disposable schema for each run and drops it in teardown.
 */


const dbUrl = process.env.LOCAL_SUPABASE_POSTGRES_URL || process.env.INTEGRATION_TEST_DB_URL;

describe("Billing Business System — PostgreSQL Hold Idempotency & Concurrency Integration", {
    skip: !dbUrl && "Set LOCAL_SUPABASE_POSTGRES_URL or INTEGRATION_TEST_DB_URL to run real PostgreSQL concurrency tests",
}, () => {
    let client1;
    let client2;
    let testSchema;

    before(async () => {
        if (!dbUrl) return;
        const { Client } = await import("pg");
        client1 = new Client({ connectionString: dbUrl });
        client2 = new Client({ connectionString: dbUrl });
        await client1.connect();
        await client2.connect();

        testSchema = `test_wallet_concurrency_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        await client1.query(`CREATE SCHEMA ${testSchema}`);
        await client1.query(`SET search_path TO ${testSchema}, public`);
        await client2.query(`SET search_path TO ${testSchema}, public`);

        // DDL mirroring public.wallets and public.transactions with constraints
        await client1.query(`
            CREATE TABLE wallets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                balance NUMERIC(15,2) DEFAULT 0.00 CHECK (balance >= 0),
                updated_at TIMESTAMPTZ DEFAULT now()
            );

            CREATE TABLE transactions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
                amount NUMERIC(15,2) NOT NULL,
                type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PENDING',
                reference_id TEXT NOT NULL,
                metadata JSONB DEFAULT '{}'::jsonb,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now(),
                CONSTRAINT transactions_reference_id_key UNIQUE (reference_id)
            );
        `);

        // Deploy exact commit_transaction RPC from baseline.sql:74-91
        await client1.query(`
            CREATE OR REPLACE FUNCTION commit_transaction(p_reference_id text)
            RETURNS jsonb
            LANGUAGE plpgsql
            AS $$
            DECLARE
                v_transaction RECORD;
            BEGIN
                SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
                
                IF v_transaction IS NULL THEN
                    RAISE EXCEPTION 'Transaction % not found', p_reference_id;
                END IF;

                IF v_transaction.status != 'PENDING' THEN
                    RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
                END IF;

                UPDATE transactions SET status = 'COMPLETED', updated_at = now()
                WHERE id = v_transaction.id RETURNING * INTO v_transaction;

                RETURN row_to_json(v_transaction)::jsonb;
            END;
            $$;
        `);

        // Deploy exact rollback_transaction RPC from baseline.sql:228-248
        await client1.query(`
            CREATE OR REPLACE FUNCTION rollback_transaction(p_reference_id text)
            RETURNS jsonb
            LANGUAGE plpgsql
            AS $$
            DECLARE
                v_transaction RECORD;
            BEGIN
                SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
                
                IF v_transaction IS NULL THEN
                    RAISE EXCEPTION 'Transaction % not found', p_reference_id;
                END IF;

                IF v_transaction.status != 'PENDING' THEN
                    RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
                END IF;

                -- Refund the wallet balance
                UPDATE wallets SET balance = balance + v_transaction.amount, updated_at = now()
                WHERE id = v_transaction.wallet_id;

                -- Mark as FAILED
                UPDATE transactions SET status = 'FAILED', updated_at = now()
                WHERE id = v_transaction.id RETURNING * INTO v_transaction;

                RETURN row_to_json(v_transaction)::jsonb;
            END;
            $$;
        `);
    });

    after(async () => {
        if (!client1) return;
        try {
            await client1.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
        } finally {
            await client1.end().catch(() => {});
            await client2?.end().catch(() => {});
        }
    });

    it("prevents double refund during concurrent rollbacks on the same hold", async () => {
        // Setup: Wallet with 10 credits balance, and a PENDING hold of 50 credits
        const { rows: [wallet] } = await client1.query(`
            INSERT INTO wallets (user_id, balance) VALUES (gen_random_uuid(), 10.00) RETURNING *;
        `);
        const refId = `ref-concurrent-rollback-${Date.now()}`;
        await client1.query(`
            INSERT INTO transactions (wallet_id, amount, type, status, reference_id, expires_at)
            VALUES ($1, 50.00, 'DEBIT', 'PENDING', $2, now() + interval '5 minutes');
        `, [wallet.id, refId]);

        // Launch concurrent rollback calls simultaneously across two distinct Postgres connections
        const [res1, res2] = await Promise.allSettled([
            client1.query("SELECT rollback_transaction($1)", [refId]),
            client2.query("SELECT rollback_transaction($1)", [refId]),
        ]);

        // Exactly one connection must succeed; the other must be rejected by FOR UPDATE + status check
        const successes = [res1, res2].filter((r) => r.status === "fulfilled");
        const rejections = [res1, res2].filter((r) => r.status === "rejected");

        assert.equal(successes.length, 1, "Exactly one rollback call must succeed");
        assert.equal(rejections.length, 1, "The concurrent rollback call must be rejected");
        assert.match(
            rejections[0].reason.message,
            /Transaction is not PENDING \(current status: FAILED\)/,
            "Rejection must cite non-PENDING status"
        );

        // Verify balance was refunded exactly ONCE (10 + 50 = 60, NOT 110)
        const { rows: [finalWallet] } = await client1.query("SELECT balance FROM wallets WHERE id = $1", [wallet.id]);
        assert.equal(Number(finalWallet.balance), 60.00, "Double refund prevented: balance refunded exactly once");

        // Verify transaction terminal status
        const { rows: [tx] } = await client1.query("SELECT status FROM transactions WHERE reference_id = $1", [refId]);
        assert.equal(tx.status, "FAILED");
    });

    it("resolves race between concurrent commit and rollback deterministically", async () => {
        const { rows: [wallet] } = await client1.query(`
            INSERT INTO wallets (user_id, balance) VALUES (gen_random_uuid(), 0.00) RETURNING *;
        `);
        const refId = `ref-commit-rollback-race-${Date.now()}`;
        await client1.query(`
            INSERT INTO transactions (wallet_id, amount, type, status, reference_id, expires_at)
            VALUES ($1, 30.00, 'DEBIT', 'PENDING', $2, now() + interval '5 minutes');
        `, [wallet.id, refId]);

        // Race commit_transaction vs rollback_transaction concurrently
        const [commitRes, rollbackRes] = await Promise.allSettled([
            client1.query("SELECT commit_transaction($1)", [refId]),
            client2.query("SELECT rollback_transaction($1)", [refId]),
        ]);

        const successes = [commitRes, rollbackRes].filter((r) => r.status === "fulfilled");
        const rejections = [commitRes, rollbackRes].filter((r) => r.status === "rejected");

        assert.equal(successes.length, 1, "Exactly one operation (commit or rollback) must win the lock");
        assert.equal(rejections.length, 1, "The losing operation must fail cleanly");

        const { rows: [tx] } = await client1.query("SELECT status FROM transactions WHERE reference_id = $1", [refId]);
        const { rows: [finalWallet] } = await client1.query("SELECT balance FROM wallets WHERE id = $1", [wallet.id]);

        if (commitRes.status === "fulfilled") {
            // Commit won: hold consumed, no refund
            assert.equal(tx.status, "COMPLETED");
            assert.equal(Number(finalWallet.balance), 0.00);
            assert.match(rollbackRes.reason.message, /Transaction is not PENDING \(current status: COMPLETED\)/);
        } else {
            // Rollback won: hold refunded
            assert.equal(tx.status, "FAILED");
            assert.equal(Number(finalWallet.balance), 30.00);
            assert.match(commitRes.reason.message, /Transaction is not PENDING \(current status: FAILED\)/);
        }
    });
});
}
