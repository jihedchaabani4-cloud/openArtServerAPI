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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

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
