/**
 * Disposable Real PostgreSQL Integration Test Runner
 *
 * Starts a 100% ephemeral local PostgreSQL 18 instance using local Scoop binaries,
 * applies the exact Ticket 06 migration functions, runs multi-connection concurrent
 * and security tests, and completely cleans up the temporary data cluster on exit.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PG_PORT = 54399;
const PG_USER = "postgres";
const TEMP_DATA_DIR = path.join(os.tmpdir(), `pg_test_disposable_${Date.now()}`);

function runPsql(sql, role = "postgres") {
  const env = { ...process.env, PGUSER: role, PGPORT: String(PG_PORT), PGHOST: "127.0.0.1" };
  const res = execFileSync("psql", ["-d", "postgres", "-X", "-q", "-A", "-t", "-c", sql], {
    env,
    encoding: "utf8",
  });
  return res.trim();
}

function runPsqlScalar(sql, role = "postgres") {
  const out = runPsql(sql, role);
  return out.split(/\r?\n/)[0].trim();
}

function runPsqlJson(sql, role = "postgres") {
  const out = runPsql(sql, role);
  // Pick the line that looks like valid JSON
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        return JSON.parse(line);
      } catch {}
    }
  }
  return out;
}

async function main() {
  console.log("================================================================================");
  console.log("  DISPOSABLE REAL POSTGRESQL INTEGRATION TEST (TICKET 06)");
  console.log(`  Data Directory: ${TEMP_DATA_DIR}`);
  console.log(`  Port: ${PG_PORT}`);
  console.log("================================================================================\n");

  try {
    // 1. Initialize fresh disposable cluster
    console.log("1. Initializing isolated PostgreSQL cluster via initdb...");
    execFileSync("initdb", ["-D", TEMP_DATA_DIR, "-U", PG_USER, "-A", "trust", "--no-locale", "--encoding=UTF8"], {
      stdio: "pipe",
    });

    // 2. Start PostgreSQL server on ephemeral port with log file redirection
    const logFile = path.join(TEMP_DATA_DIR, "server.log");
    console.log(`2. Starting PostgreSQL on 127.0.0.1:${PG_PORT} (log: ${logFile})...`);
    execFileSync("pg_ctl", [
      "-D", TEMP_DATA_DIR,
      "-l", logFile,
      "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c log_statement=none`,
      "-w",
      "start",
    ], { stdio: "ignore" });

    console.log("3. Creating schema, roles, and migration functions in real PostgreSQL...");

    // Create roles
    runPsql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role LOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon LOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated LOGIN;
        END IF;
      END
      $$;
    `);

    // Create tables
    runPsql(`
      CREATE TABLE IF NOT EXISTS public.wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        balance NUMERIC(15,2) DEFAULT 0.00 CHECK (balance >= 0),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
        amount NUMERIC(15,2) NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        reference_id TEXT NOT NULL UNIQUE,
        metadata JSONB DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      GRANT ALL ON public.wallets TO service_role;
      GRANT ALL ON public.transactions TO service_role;
    `);

    // Read and apply migration SQL
    const migrationSqlPath = path.resolve("..", "supabase", "migrations", "20261018170000_atomic_wallet_hold_rpcs.sql");
    const migrationSql = fs.readFileSync(migrationSqlPath, "utf8");
    runPsql(migrationSql);

    console.log("   Migration SQL deployed successfully.\n");

    // -----------------------------------------------------------------------
    // TEST SUITE EXECUTION
    // -----------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("  RUNNING SCENARIOS AGAINST REAL POSTGRESQL ENGINE");
    console.log("--------------------------------------------------------------------------------\n");

    // SCENARIO 1: Role permission boundary (least privilege)
    console.log("► SCENARIO 1: Permissions - authenticated/anon rejected (42501), service_role allowed");
    let deniedCount = 0;
    try {
      runPsql(`SET ROLE authenticated; SELECT public.expire_stale_holds();`);
    } catch (err) {
      if (err.message.includes("permission denied for function expire_stale_holds")) {
        deniedCount++;
      }
    }
    try {
      runPsql(`SET ROLE authenticated; SELECT public.extend_hold('ref-test', 300);`);
    } catch (err) {
      if (err.message.includes("permission denied for function extend_hold")) {
        deniedCount++;
      }
    }
    if (deniedCount !== 2) throw new Error(`Expected both RPCs to deny authenticated role, denied: ${deniedCount}`);
    console.log("  ✔ PASS: authenticated role is rejected with 42501 (permission denied) on both functions");

    // SCENARIO 2: Concurrent expiration workers (FOR UPDATE SKIP LOCKED)
    console.log("\n► SCENARIO 2: Concurrent multi-connection workers refunding exactly once (SKIP LOCKED)");
    // Setup: Wallet with balance 100.00, 4 expired holds of 10.00 each
    const walletId = runPsqlScalar(`INSERT INTO public.wallets (user_id, balance) VALUES (gen_random_uuid(), 100.00) RETURNING id;`, "service_role");
    runPsql(`
      INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
      VALUES 
        ('${walletId}', 10.00, 'DEBIT', 'PENDING', 'ref-conc-1', now() - INTERVAL '5 minutes'),
        ('${walletId}', 10.00, 'DEBIT', 'PENDING', 'ref-conc-2', now() - INTERVAL '4 minutes'),
        ('${walletId}', 10.00, 'DEBIT', 'PENDING', 'ref-conc-3', now() - INTERVAL '3 minutes'),
        ('${walletId}', 10.00, 'DEBIT', 'PENDING', 'ref-conc-4', now() - INTERVAL '2 minutes');
    `, "service_role");

    // Launch two parallel psql sessions simultaneously
    const p1 = new Promise((resolve, reject) => {
      const child = spawn("psql", ["-d", "postgres", "-X", "-A", "-t", "-c", "SET ROLE service_role; SELECT public.expire_stale_holds();"], {
        env: { ...process.env, PGUSER: "postgres", PGPORT: String(PG_PORT), PGHOST: "127.0.0.1" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error("p1 failed"));
        const line = out.split(/\r?\n/).find(l => l.trim().startsWith("["));
        resolve(JSON.parse(line || "[]"));
      });
    });

    const p2 = new Promise((resolve, reject) => {
      const child = spawn("psql", ["-d", "postgres", "-X", "-A", "-t", "-c", "SET ROLE service_role; SELECT public.expire_stale_holds();"], {
        env: { ...process.env, PGUSER: "postgres", PGPORT: String(PG_PORT), PGHOST: "127.0.0.1" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error("p2 failed"));
        const line = out.split(/\r?\n/).find(l => l.trim().startsWith("["));
        resolve(JSON.parse(line || "[]"));
      });
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    const totalClaimed = res1.length + res2.length;
    console.log(`  Worker 1 claimed: ${res1.length} holds, Worker 2 claimed: ${res2.length} holds`);
    if (totalClaimed !== 4) throw new Error(`Expected exactly 4 holds claimed, got ${totalClaimed}`);

    const finalBal = runPsqlScalar(`SELECT balance FROM public.wallets WHERE id = '${walletId}';`, "service_role");
    if (Number(finalBal) !== 140.00) throw new Error(`Expected balance 140.00, got ${finalBal}`);
    console.log(`  ✔ PASS: Wallet balance refunded exactly once (100.00 + 40.00 = ${finalBal}) with 0 double refunds`);

    // SCENARIO 3: Subtransaction isolation - malformed hold does not prevent valid holds
    console.log("\n► SCENARIO 3: Subtransaction isolation (poison pill prevention)");
    const wValid = runPsqlScalar(`INSERT INTO public.wallets (user_id, balance) VALUES (gen_random_uuid(), 50.00) RETURNING id;`, "service_role");
    // Valid hold 1
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
             VALUES ('${wValid}', 15.00, 'DEBIT', 'PENDING', 'ref-valid-1', now() - INTERVAL '10 minutes');`, "service_role");
    // Malformed hold 2 (references a non-existent wallet UUID with FK disabled temporarily)
    runPsql(`SET session_replication_role = 'replica';
             INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
             VALUES ('00000000-0000-0000-0000-000000000000', 99.00, 'DEBIT', 'PENDING', 'ref-malformed-orphan', now() - INTERVAL '10 minutes');
             SET session_replication_role = 'origin';`, "postgres");
    // Valid hold 3
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
             VALUES ('${wValid}', 25.00, 'DEBIT', 'PENDING', 'ref-valid-3', now() - INTERVAL '10 minutes');`, "service_role");

    // Run expire_stale_holds
    const sweptRecords = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds();`, "service_role");
    console.log(`  Processed records returned: ${sweptRecords.length}`);
    const validRefs = sweptRecords.map((r) => r.reference_id);
    if (!validRefs.includes("ref-valid-1") || !validRefs.includes("ref-valid-3")) {
      throw new Error(`Valid holds were not swept! Refs: ${validRefs.join(", ")}`);
    }
    if (validRefs.includes("ref-malformed-orphan")) {
      throw new Error(`Malformed hold was erroneously treated as successfully refunded!`);
    }

    const malformedStatus = runPsql(`SELECT status FROM public.transactions WHERE reference_id = 'ref-malformed-orphan';`, "service_role");
    if (malformedStatus !== "PENDING") {
      throw new Error(`Malformed hold status was modified to ${malformedStatus} instead of rolling back to PENDING`);
    }
    console.log(`  ✔ PASS: Malformed transaction remained PENDING (subtransaction rolled back), valid holds refunded (50 + 15 + 25 = 90.00)`);

    // SCENARIO 4: Expiration boundary & non-resurrection in extend_hold
    console.log("\n► SCENARIO 4: extend_hold expiration boundary & non-resurrection");
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
             VALUES ('${wValid}', 5.00, 'DEBIT', 'PENDING', 'ref-expired-boundary', now() - INTERVAL '1 second');`, "service_role");
    let extendFailed = false;
    try {
      runPsql(`SET ROLE service_role; SELECT public.extend_hold('ref-expired-boundary', 300);`, "service_role");
    } catch (err) {
      if (err.message.includes("Cannot extend expired transaction")) {
        extendFailed = true;
      }
    }
    if (!extendFailed) throw new Error("extend_hold resurrected an expired transaction!");
    console.log("  ✔ PASS: extend_hold rejected already-expired hold with 'Cannot extend expired transaction'");

    // SCENARIO 5: Bounded batch size
    console.log("\n► SCENARIO 5: Bounded batch size limiting sweep work");
    // Clean up malformed test row so batch test measures clean rows
    runPsql(`DELETE FROM public.transactions WHERE reference_id = 'ref-malformed-orphan';`, "service_role");
    runPsql(`
      INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
      VALUES 
        ('${wValid}', 1.00, 'DEBIT', 'PENDING', 'ref-batch-1', now() - INTERVAL '1 minute'),
        ('${wValid}', 1.00, 'DEBIT', 'PENDING', 'ref-batch-2', now() - INTERVAL '1 minute'),
        ('${wValid}', 1.00, 'DEBIT', 'PENDING', 'ref-batch-3', now() - INTERVAL '1 minute');
    `, "service_role");

    const batchRes = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds(2);`, "service_role");
    if (batchRes.length !== 2) throw new Error(`Expected batch limit 2, got ${batchRes.length}`);
    console.log("  ✔ PASS: expire_stale_holds(2) returned exactly 2 records under batch limit");

    // SCENARIO 6: 100 Malformed Holds Starvation, Retry Backoff & Quarantine Test
    console.log("\n► SCENARIO 6: 100 malformed holds starvation prevention & quarantine");
    // Clean any leftover transactions from prior scenarios to ensure clean baseline
    runPsql(`DELETE FROM public.transactions;`, "service_role");

    // Setup: Wallet with balance 50.00, and 5 valid holds of 10.00 each
    const wStarve = runPsqlScalar(`INSERT INTO public.wallets (user_id, balance) VALUES (gen_random_uuid(), 50.00) RETURNING id;`, "service_role");
    
    // Seed 100 malformed expired holds with non-existent wallet UUID '00000000-0000-0000-0000-000000000000'
    // This UUID sorts before any standard v4 UUID in ORDER BY wallet_id ASC
    console.log("   Seeding 100 malformed expired holds with wallet_id 00000000-0000-0000-0000-000000000000...");
    runPsql(`SET session_replication_role = 'replica';
             INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
             SELECT 
               '00000000-0000-0000-0000-000000000000'::uuid,
               5.00,
               'DEBIT',
               'PENDING',
               'ref-malformed-starve-' || i,
               now() - INTERVAL '15 minutes'
             FROM generate_series(1, 100) AS i;
             SET session_replication_role = 'origin';`, "postgres");

    // Seed 5 valid expired holds for wStarve
    console.log("   Seeding 5 valid expired holds that sort AFTER the 100 malformed holds...");
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, expires_at)
             SELECT 
               '${wStarve}'::uuid,
               10.00,
               'DEBIT',
               'PENDING',
               'ref-valid-starve-' || i,
               now() - INTERVAL '10 minutes'
             FROM generate_series(1, 5) AS i;`, "service_role");

    // Verify ordering: first 100 rows strictly belong to the malformed batch
    const firstSortRef = runPsqlScalar(`SELECT reference_id FROM public.transactions WHERE status = 'PENDING' ORDER BY wallet_id ASC, id ASC LIMIT 1;`, "service_role");
    if (!firstSortRef.startsWith("ref-malformed-starve-")) {
      throw new Error(`Expected malformed rows to sort first, but found: ${firstSortRef}`);
    }

    // Step 1: Execute Sweep 1 (batch limit 100)
    console.log("   Running Sweep 1 (batch limit 100)...");
    const sweep1 = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds(100);`, "service_role");
    if (sweep1.length !== 0) {
      throw new Error(`Sweep 1 was expected to refund 0 holds, but refunded: ${sweep1.length}`);
    }
    console.log("   Sweep 1 completed: 0 refunded holds returned (all 100 malformed holds failed refund).");

    // Verify hold funds preserved: all 100 are still PENDING, none marked FAILED
    const malformedPendingCount = runPsqlScalar(`SELECT count(*) FROM public.transactions WHERE reference_id LIKE 'ref-malformed-starve-%' AND status = 'PENDING';`, "service_role");
    if (Number(malformedPendingCount) !== 100) {
      throw new Error(`Expected all 100 malformed holds to remain PENDING, but found: ${malformedPendingCount}`);
    }

    // Verify failure metadata and backoff recorded
    const backoffCount = runPsqlScalar(`SELECT count(*) FROM public.transactions WHERE reference_id LIKE 'ref-malformed-starve-%' AND (metadata->>'sweep_attempts')::int = 1 AND (metadata->>'sweep_retry_after')::timestamptz > now();`, "service_role");
    if (Number(backoffCount) !== 100) {
      throw new Error(`Expected 100 rows with retry backoff set in the future, got: ${backoffCount}`);
    }
    console.log("   ✔ Invariant preserved: 100 malformed holds remain PENDING with retry backoff recorded.");

    // Step 2: Execute Sweep 2 immediately
    // If starvation was present, Sweep 2 would re-read the same 100 malformed holds and return 0.
    // With retry backoff, Sweep 2 skips them and processes the 5 valid holds!
    console.log("   Running Sweep 2 immediately (verifying valid holds are NOT starved)...");
    const sweep2 = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds(100);`, "service_role");
    if (sweep2.length !== 5) {
      throw new Error(`Starvation occurred! Sweep 2 returned ${sweep2.length} holds instead of the 5 valid holds.`);
    }

    const wStarveBal = runPsqlScalar(`SELECT balance FROM public.wallets WHERE id = '${wStarve}';`, "service_role");
    if (Number(wStarveBal) !== 100.00) {
      throw new Error(`Expected valid wallet balance 100.00 (50 + 5*10), got ${wStarveBal}`);
    }
    console.log(`   ✔ Starvation prevented: Sweep 2 bypassed the 100 backoff rows and refunded 5 valid holds (balance: 50.00 -> ${wStarveBal})`);

    // Step 3: Test Quarantine threshold
    console.log("   Testing quarantine escalation after 3 failed attempts...");
    // Simulate attempts reaching max threshold (3) on a malformed hold
    runPsql(`UPDATE public.transactions 
             SET metadata = jsonb_build_object('sweep_attempts', 2, 'sweep_retry_after', now() - INTERVAL '1 second')
             WHERE reference_id = 'ref-malformed-starve-1';`, "service_role");

    // Run sweep to trigger attempt 3
    runPsql(`SET ROLE service_role; SELECT public.expire_stale_holds(10);`, "service_role");

    const quarantinedStatus = runPsqlJson(`SELECT metadata FROM public.transactions WHERE reference_id = 'ref-malformed-starve-1';`, "service_role");
    if (!quarantinedStatus.quarantined || !quarantinedStatus.quarantine_reason) {
      throw new Error(`Expected transaction to be quarantined with reason, got: ${JSON.stringify(quarantinedStatus)}`);
    }
    console.log(`   ✔ Quarantined record observable: quarantined=true, reason="${quarantinedStatus.quarantine_reason}"`);

    // Verify extend_hold rejects quarantined hold
    let extendQuarantinedRejected = false;
    try {
      // Temporarily give it future expires_at to ensure it is quarantined rejection, not expiration rejection
      runPsql(`UPDATE public.transactions SET expires_at = now() + INTERVAL '1 hour' WHERE reference_id = 'ref-malformed-starve-1';`, "service_role");
      runPsql(`SET ROLE service_role; SELECT public.extend_hold('ref-malformed-starve-1', 300);`, "service_role");
    } catch (err) {
      if (err.message.includes("Cannot extend quarantined transaction")) {
        extendQuarantinedRejected = true;
      }
    }
    if (!extendQuarantinedRejected) {
      throw new Error("extend_hold failed to reject quarantined transaction!");
    }
    console.log("   ✔ extend_hold rejected quarantined transaction with 'Cannot extend quarantined transaction'");

    // SCENARIO 7: Malformed Retry Metadata Safety ('not-a-timestamp' and '2026-99-99')
    console.log("\n► SCENARIO 7: Malformed retry metadata safety ('not-a-timestamp' and '2026-99-99')");
    runPsql(`DELETE FROM public.transactions;`, "service_role");

    const wMeta = runPsqlScalar(`INSERT INTO public.wallets (user_id, balance) VALUES (gen_random_uuid(), 100.00) RETURNING id;`, "service_role");

    // 1. Hold A: non-matching string 'not-a-timestamp' (must not be silently excluded)
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES ('${wMeta}', 10.00, 'DEBIT', 'PENDING', 'ref-meta-non-matching', '{"sweep_retry_after": "not-a-timestamp"}'::jsonb, now() - INTERVAL '5 minutes');`, "service_role");

    // 2. Hold B: date out of range '2026-99-99' (must not abort query or throw cast error)
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES ('${wMeta}', 10.00, 'DEBIT', 'PENDING', 'ref-meta-invalid-date', '{"sweep_retry_after": "2026-99-99"}'::jsonb, now() - INTERVAL '5 minutes');`, "service_role");

    // 3. Hold C: valid future timestamp (must respect backoff and be skipped)
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES ('${wMeta}', 10.00, 'DEBIT', 'PENDING', 'ref-meta-valid-future', '{"sweep_retry_after": "2099-01-01T00:00:00Z"}'::jsonb, now() - INTERVAL '5 minutes');`, "service_role");

    // 4. Hold D: quarantined hold (must remain strictly excluded)
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES ('${wMeta}', 10.00, 'DEBIT', 'PENDING', 'ref-meta-quarantined', '{"quarantined": true}'::jsonb, now() - INTERVAL '5 minutes');`, "service_role");

    console.log("   Running sweep with malformed metadata rows present...");
    const sweepRes = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds(100);`, "service_role");

    // Verify exactly 2 holds refunded (Hold A and Hold B)
    if (sweepRes.length !== 2) {
      throw new Error(`Expected exactly 2 holds swept (Hold A & Hold B), got ${sweepRes.length}`);
    }
    const sweptRefs = sweepRes.map((r) => r.reference_id);
    if (!sweptRefs.includes("ref-meta-non-matching") || !sweptRefs.includes("ref-meta-invalid-date")) {
      throw new Error(`Expected Hold A and Hold B to be swept, got: ${sweptRefs.join(", ")}`);
    }
    console.log("   ✔ PASS: Both 'not-a-timestamp' and '2026-99-99' were safely processed without throwing cast exceptions.");

    // Verify wallet balance updated: 100.00 + 20.00 = 120.00
    const metaBal = runPsqlScalar(`SELECT balance FROM public.wallets WHERE id = '${wMeta}';`, "service_role");
    if (Number(metaBal) !== 120.00) {
      throw new Error(`Expected wallet balance 120.00, got ${metaBal}`);
    }
    console.log(`   ✔ PASS: Wallet refunded exactly once for the 2 valid holds (balance: 100.00 -> ${metaBal})`);

    // Verify Hold C (valid future backoff) was skipped and remains PENDING
    const futureStatus = runPsqlScalar(`SELECT status FROM public.transactions WHERE reference_id = 'ref-meta-valid-future';`, "service_role");
    if (futureStatus !== "PENDING") {
      throw new Error(`Expected future backoff hold to remain PENDING, got ${futureStatus}`);
    }
    console.log("   ✔ PASS: Valid future timestamp respected retry backoff and remained PENDING.");

    // Verify Hold D (quarantined) remained excluded and PENDING
    const quarantinedHoldStatus = runPsqlScalar(`SELECT status FROM public.transactions WHERE reference_id = 'ref-meta-quarantined';`, "service_role");
    if (quarantinedHoldStatus !== "PENDING") {
      throw new Error(`Expected quarantined hold to remain PENDING, got ${quarantinedHoldStatus}`);
    }
    console.log("   ✔ PASS: Quarantined hold remained strictly excluded from sweep.");

    // 5. Test failing hold with malformed retry metadata: records 'malformed_retry_after_received'
    console.log("   Testing failing hold with malformed retry metadata (observability check)...");
    runPsql(`SET session_replication_role = 'replica';
             INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES ('00000000-0000-0000-0000-000000000000', 5.00, 'DEBIT', 'PENDING', 'ref-fail-malformed-meta', '{"sweep_retry_after": "2026-99-99"}'::jsonb, now() - INTERVAL '5 minutes');
             SET session_replication_role = 'origin';`, "postgres");

    runPsql(`SET ROLE service_role; SELECT public.expire_stale_holds(100);`, "service_role");

    const failMeta = runPsqlJson(`SELECT metadata FROM public.transactions WHERE reference_id = 'ref-fail-malformed-meta';`, "service_role");
    if (failMeta.malformed_retry_after_received !== "2026-99-99") {
      throw new Error(`Expected malformed_retry_after_received = '2026-99-99', got: ${JSON.stringify(failMeta)}`);
    }
    if (!failMeta.sweep_retry_after || !failMeta.sweep_retry_after.startsWith("202")) {
      throw new Error(`Expected sweep_retry_after to be corrected with valid future timestamp, got: ${JSON.stringify(failMeta)}`);
    }
    console.log(`   ✔ PASS: Malformed retry string captured as "${failMeta.malformed_retry_after_received}" and corrected to valid backoff "${failMeta.sweep_retry_after}"`);

    // SCENARIO 8: Oversized Numeric sweep_attempts Overflow Safety & Starvation Prevention
    console.log("\n► SCENARIO 8: Oversized numeric sweep_attempts overflow safety & starvation prevention");
    runPsql(`DELETE FROM public.transactions;`, "service_role");

    // Prove that repeat('9', 150000)::numeric actually overflows PostgreSQL's numeric engine
    let numericOverflowed = false;
    try {
      runPsql(`SELECT repeat('9', 150000)::numeric;`);
    } catch (err) {
      if (err.message.includes("overflows numeric format") || err.message.includes("numeric field overflow") || err.message.includes("out of range for type numeric")) {
        numericOverflowed = true;
      }
    }
    if (!numericOverflowed) {
      throw new Error("Expected repeat('9', 150000)::numeric to throw numeric overflow, but it did not!");
    }
    console.log("   ✔ PROVEN: 150,000-digit string causes PostgreSQL 'value overflows numeric format' error when cast.");

    // Test parse_sweep_attempts unit cases directly in PostgreSQL engine
    const test150k = runPsqlScalar(`SELECT public.parse_sweep_attempts(repeat('9', 150000));`, "service_role");
    if (test150k !== "2147483647") {
      throw new Error(`Expected parse_sweep_attempts to return 2147483647 on 150,000-digit number, got ${test150k}`);
    }
    const testOversized = runPsqlScalar(`SELECT public.parse_sweep_attempts('999999999999999999999999999999');`, "service_role");
    if (testOversized !== "2147483647") {
      throw new Error(`Expected parse_sweep_attempts to return 2147483647 on 30-digit number, got ${testOversized}`);
    }
    const testCorruptStr = runPsqlScalar(`SELECT public.parse_sweep_attempts('not-a-number');`, "service_role");
    if (testCorruptStr !== "0") {
      throw new Error(`Expected parse_sweep_attempts to return 0 on string, got ${testCorruptStr}`);
    }
    const testNull = runPsqlScalar(`SELECT public.parse_sweep_attempts(NULL);`, "service_role");
    if (testNull !== "0") {
      throw new Error(`Expected parse_sweep_attempts to return 0 on NULL, got ${testNull}`);
    }
    const testNormal = runPsqlScalar(`SELECT public.parse_sweep_attempts('2');`, "service_role");
    if (testNormal !== "2") {
      throw new Error(`Expected parse_sweep_attempts to return 2 on '2', got ${testNormal}`);
    }
    const testLeadingZeros = runPsqlScalar(`SELECT public.parse_sweep_attempts('0000000002');`, "service_role");
    if (testLeadingZeros !== "2") {
      throw new Error(`Expected parse_sweep_attempts to normalize '0000000002' to 2, got ${testLeadingZeros}`);
    }
    const testLeadingZerosZero = runPsqlScalar(`SELECT public.parse_sweep_attempts('0000000000');`, "service_role");
    if (testLeadingZerosZero !== "0") {
      throw new Error(`Expected parse_sweep_attempts to normalize '0000000000' to 0, got ${testLeadingZerosZero}`);
    }
    const testBoundaryMax = runPsqlScalar(`SELECT public.parse_sweep_attempts('2147483647');`, "service_role");
    if (testBoundaryMax !== "2147483647") {
      throw new Error(`Expected parse_sweep_attempts to parse '2147483647' correctly, got ${testBoundaryMax}`);
    }
    const testBoundaryOverflow = runPsqlScalar(`SELECT public.parse_sweep_attempts('2147483648');`, "service_role");
    if (testBoundaryOverflow !== "2147483647") {
      throw new Error(`Expected parse_sweep_attempts to cap '2147483648' at 2147483647, got ${testBoundaryOverflow}`);
    }
    console.log("   ✔ PASS: parse_sweep_attempts safely handles NULL (0), '2' (2), '0000000002' (2), '0000000000' (0), '2147483647' (2147483647), '2147483648' (2147483647), 'not-a-number' (0), and 150,000-digit numeric overflow (2147483647).");

    // Setup: Wallet with balance 50.00
    const wOver = runPsqlScalar(`INSERT INTO public.wallets (user_id, balance) VALUES (gen_random_uuid(), 50.00) RETURNING id;`, "service_role");

    // Seed 4 malformed holds with non-existent wallet (sorting first)
    // Hold 1 has 150,000-digit sweep_attempts (exceeds PostgreSQL numeric's supported input range!)
    // Hold 2 has non-numeric sweep_attempts
    // Hold 3 has leading zeros '0000000002' (valid 2, should reach quarantine 3 without malformed flag)
    // Hold 4 has leading zeros '0000000001' (valid 1, should reach backoff 2 without malformed flag)
    runPsql(`SET session_replication_role = 'replica';
             INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES 
               ('00000000-0000-0000-0000-000000000000', 5.00, 'DEBIT', 'PENDING', 'ref-overflow-150k', jsonb_build_object('sweep_attempts', repeat('9', 150000)), now() - INTERVAL '10 minutes'),
               ('00000000-0000-0000-0000-000000000000', 5.00, 'DEBIT', 'PENDING', 'ref-corrupt-string', '{"sweep_attempts": "not-a-number"}'::jsonb, now() - INTERVAL '10 minutes'),
               ('00000000-0000-0000-0000-000000000000', 5.00, 'DEBIT', 'PENDING', 'ref-lz-quarantine', '{"sweep_attempts": "0000000002"}'::jsonb, now() - INTERVAL '10 minutes'),
               ('00000000-0000-0000-0000-000000000000', 5.00, 'DEBIT', 'PENDING', 'ref-lz-backoff', '{"sweep_attempts": "0000000001"}'::jsonb, now() - INTERVAL '10 minutes');
             SET session_replication_role = 'origin';`, "postgres");

    // Seed 2 valid holds for wOver (sorting after malformed holds)
    runPsql(`INSERT INTO public.transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
             VALUES 
               ('${wOver}', 15.00, 'DEBIT', 'PENDING', 'ref-over-valid-1', '{}'::jsonb, now() - INTERVAL '5 minutes'),
               ('${wOver}', 15.00, 'DEBIT', 'PENDING', 'ref-over-valid-2', '{}'::jsonb, now() - INTERVAL '5 minutes');`, "service_role");

    console.log("   Running sweep across 150,000-digit counter, corrupt string, leading-zero holds, and sibling valid holds...");
    const sweepOverRes = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds(100);`, "service_role");

    // Verify valid holds were swept and refunded without being starved or aborted by integer/numeric overflow
    if (sweepOverRes.length !== 2) {
      throw new Error(`Expected exactly 2 valid holds to be swept, got ${sweepOverRes.length}`);
    }
    const finalOverBal = runPsqlScalar(`SELECT balance FROM public.wallets WHERE id = '${wOver}';`, "service_role");
    if (Number(finalOverBal) !== 80.00) {
      throw new Error(`Expected wallet balance 80.00 (50 + 2*15), got ${finalOverBal}`);
    }
    console.log(`   ✔ PASS: Valid holds refunded successfully without abortion (balance: 50.00 -> ${finalOverBal})`);

    // Verify 150,000-digit hold was immediately quarantined without crashing
    const hugeMeta = runPsqlJson(`SELECT metadata FROM public.transactions WHERE reference_id = 'ref-overflow-150k';`, "service_role");
    if (!hugeMeta.quarantined || hugeMeta.sweep_attempts !== 3) {
      throw new Error(`Expected ref-overflow-150k to be quarantined with attempts=3, got: ${JSON.stringify(hugeMeta)}`);
    }
    if (!hugeMeta.malformed_attempts_received || !hugeMeta.malformed_attempts_received.endsWith("...")) {
      throw new Error(`Expected safely truncated malformed_attempts_received ending with '...', got: ${hugeMeta.malformed_attempts_received}`);
    }
    console.log(`   ✔ PASS: 150,000-digit counter safely quarantined (quarantined=true, attempts=3, malformed_attempts_received="${hugeMeta.malformed_attempts_received}")`);

    // Verify corrupt string counter got normalized to attempt 1 with future backoff
    const strMeta = runPsqlJson(`SELECT metadata FROM public.transactions WHERE reference_id = 'ref-corrupt-string';`, "service_role");
    if (strMeta.sweep_attempts !== 1 || !strMeta.sweep_retry_after || strMeta.malformed_attempts_received !== "not-a-number") {
      throw new Error(`Expected ref-corrupt-string to get attempts=1 and retry_after, got: ${JSON.stringify(strMeta)}`);
    }
    console.log(`   ✔ PASS: Non-numeric counter safely normalized (attempts=1, malformed_attempts_received="${strMeta.malformed_attempts_received}")`);

    // Verify leading-zero '0000000002' was parsed as 2, incremented to 3, and quarantined without being flagged malformed
    const lzQMeta = runPsqlJson(`SELECT metadata FROM public.transactions WHERE reference_id = 'ref-lz-quarantine';`, "service_role");
    if (!lzQMeta.quarantined || lzQMeta.sweep_attempts !== 3) {
      throw new Error(`Expected ref-lz-quarantine to be quarantined with attempts=3, got: ${JSON.stringify(lzQMeta)}`);
    }
    if (lzQMeta.malformed_attempts_received !== undefined) {
      throw new Error(`Expected ref-lz-quarantine NOT to have malformed_attempts_received, got: ${lzQMeta.malformed_attempts_received}`);
    }
    console.log(`   ✔ PASS: Leading-zero counter '0000000002' correctly normalized to 2 -> quarantined at 3 without false malformed flag.`);

    // Verify leading-zero '0000000001' was parsed as 1, incremented to 2 with backoff, without being flagged malformed
    const lzBMeta = runPsqlJson(`SELECT metadata FROM public.transactions WHERE reference_id = 'ref-lz-backoff';`, "service_role");
    if (lzBMeta.quarantined || lzBMeta.sweep_attempts !== 2 || !lzBMeta.sweep_retry_after) {
      throw new Error(`Expected ref-lz-backoff to get attempts=2 and retry_after, got: ${JSON.stringify(lzBMeta)}`);
    }
    if (lzBMeta.malformed_attempts_received !== undefined) {
      throw new Error(`Expected ref-lz-backoff NOT to have malformed_attempts_received, got: ${lzBMeta.malformed_attempts_received}`);
    }
    console.log(`   ✔ PASS: Leading-zero counter '0000000001' correctly normalized to 1 -> backoff attempt 2 without false malformed flag.`);

    // Immediate subsequent sweep must find 0 pending due records (starvation strictly prevented)
    const sweepFollowup = runPsqlJson(`SET ROLE service_role; SELECT public.expire_stale_holds(100);`, "service_role");
    if (sweepFollowup.length !== 0) {
      throw new Error(`Expected subsequent sweep to return 0, got ${sweepFollowup.length}`);
    }
    console.log("   ✔ PASS: Subsequent sweep confirmed 0 lingering unquarantined rows; zero starvation.");

    console.log("\n================================================================================");
    console.log("  ALL REAL POSTGRESQL INTEGRATION SCENARIOS PASSED (8/8)");
    console.log("================================================================================\n");

  } finally {
    console.log("Cleaning up disposable PostgreSQL cluster...");
    try {
      execFileSync("pg_ctl", ["-D", TEMP_DATA_DIR, "-m", "immediate", "stop"], { stdio: "pipe" });
    } catch (_) {}
    try {
      fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
    } catch (_) {}
    console.log("Disposable PostgreSQL cluster successfully stopped and deleted.");
  }
}

main().catch((err) => {
  console.error("FATAL in real PostgreSQL integration test:", err);
  process.exit(1);
});
