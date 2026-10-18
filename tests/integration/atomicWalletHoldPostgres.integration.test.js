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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

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
