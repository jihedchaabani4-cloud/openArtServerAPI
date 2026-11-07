/**
 * Disposable Real PostgreSQL Integration Test Runner for Shared Media Concurrency
 *
 * Starts a 100% ephemeral local PostgreSQL instance using local Scoop binaries,
 * applies the canonical production migrations for attach and unlink/reap, executes real
 * multi-connection concurrency and security tests, and cleans up the cluster on exit.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isWorkflowReferenceQuotaError } from "../src/platform/media-ingestion/MediaUploadErrors.js";

const PG_PORT = 54400;
const PG_USER = "postgres";
const TEMP_DATA_DIR = path.join(os.tmpdir(), `pg_test_shared_media_${Date.now()}`);

function runPsql(sql, role = "postgres") {
  const env = {
    ...process.env,
    PGUSER: role,
    PGPORT: String(PG_PORT),
    PGHOST: "127.0.0.1",
    PGCLIENTENCODING: "UTF8",
    LC_ALL: "C",
    LC_MESSAGES: "C",
    LANGUAGE: "en",
  };
  const res = execFileSync("psql", ["-d", "postgres", "-X", "-q", "-A", "-t", "-c", sql], {
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return res.trim();
}

function extractHint(err) {
  if (err?.hint) return err.hint;
  const combined = `${err?.message || ""}\n${err?.stderr || ""}`;
  const m = combined.match(/(?:HINT|ASTUCE)\s*:\s*([^\r\n]+)/i);
  return m ? m[1].trim() : null;
}

function runPsqlTable(sql, role = "postgres") {
  const env = { ...process.env, PGUSER: role, PGPORT: String(PG_PORT), PGHOST: "127.0.0.1", PGCLIENTENCODING: "UTF8" };
  const res = execFileSync("psql", ["-d", "postgres", "-X", "-c", sql], {
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return res.trim();
}

function runPsqlScalar(sql, role = "postgres") {
  const out = runPsql(sql, role);
  return out.split(/\r?\n/)[0].trim();
}

function runPsqlJson(sql, role = "postgres") {
  const out = runPsql(sql, role);
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
  console.log("  DISPOSABLE REAL POSTGRESQL TEST: SHARED MEDIA CONCURRENCY & ORPHAN REAPING");
  console.log(`  Data Directory: ${TEMP_DATA_DIR}`);
  console.log(`  Port: ${PG_PORT}`);
  console.log("================================================================================\n");

  try {
    // 1. Initialize isolated cluster
    console.log("1. Initializing isolated PostgreSQL cluster via initdb...");
    execFileSync("initdb", ["-D", TEMP_DATA_DIR, "-U", PG_USER, "-A", "trust", "--no-locale", "--encoding=UTF8"], {
      stdio: "pipe",
    });

    // 2. Start PostgreSQL
    const logFile = path.join(TEMP_DATA_DIR, "server.log");
    console.log(`2. Starting PostgreSQL on 127.0.0.1:${PG_PORT}...`);
    execFileSync("pg_ctl", [
      "-D", TEMP_DATA_DIR,
      "-l", logFile,
      "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c log_statement=none`,
      "-w",
      "start",
    ], { stdio: "ignore" });

    console.log("3. Creating baseline tables, roles, and applying canonical production migrations...");

    // Create Supabase standard roles
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

    // Create baseline tables matching canonical production schema (ADR 0006 & ADR 0007)
    runPsql(`
      CREATE TABLE IF NOT EXISTS public.media (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url TEXT NOT NULL,
        project_id UUID,
        user_id UUID,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.workflow (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        project_id UUID NOT NULL,
        title TEXT,
        primary_media_id UUID REFERENCES public.media(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.workflow_media (
        workflow_id UUID NOT NULL REFERENCES public.workflow(id) ON DELETE CASCADE,
        media_id UUID NOT NULL REFERENCES public.media(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'output',
        is_primary BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT workflow_media_pkey PRIMARY KEY (workflow_id, media_id, role),
        CONSTRAINT workflow_media_role_check CHECK (
          role = ANY (ARRAY[
            'output',
            'original',
            'sheet',
            'detail',
            'reference',
            'avatar',
            'turnaround'
          ])
        )
      );

      -- Partial unique index for primary cover (at most one per workflow container)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_media_single_primary
        ON public.workflow_media (workflow_id) WHERE is_primary = true;

      GRANT ALL ON public.workflow TO service_role;
      GRANT ALL ON public.media TO service_role;
      GRANT ALL ON public.workflow_media TO service_role;
    `);

    // Apply Migration 1: Attach RPC (strictly from canonical supabase/migrations)
    const attachMigrationPath = path.resolve(import.meta.dirname, "..", "supabase", "migrations", "20261020020000_atomic_attach_workflow_reference_media_rpc.sql");
    if (!fs.existsSync(attachMigrationPath)) {
      throw new Error(`Canonical migration file missing: ${attachMigrationPath}`);
    }
    const attachSql = fs.readFileSync(attachMigrationPath, "utf8");
    runPsql(attachSql);

    // Apply Migration 2: Unlink & Reap RPC (strictly from canonical supabase/migrations)
    const unlinkMigrationPath = path.resolve(import.meta.dirname, "..", "supabase", "migrations", "20261020030000_atomic_unlink_workflow_media_and_reap_orphan_rpc.sql");
    if (!fs.existsSync(unlinkMigrationPath)) {
      throw new Error(`Canonical migration file missing: ${unlinkMigrationPath}`);
    }
    const unlinkSql = fs.readFileSync(unlinkMigrationPath, "utf8");
    runPsql(unlinkSql);

    console.log("   Canonical migrations (20261020020000 & 20261020030000) applied successfully.\n");

    // Apply Promoted Migration: 20261024000000_add_auto_primary_to_attach_reference_media.sql (from canonical supabase/migrations)
    console.log("   Applying promoted migration: 20261024000000_add_auto_primary_to_attach_reference_media.sql...");
    const migrationPath = path.resolve(import.meta.dirname, "..", "supabase", "migrations", "20261024000000_add_auto_primary_to_attach_reference_media.sql");
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Promoted migration file missing: ${migrationPath}`);
    }
    const migrationSql = fs.readFileSync(migrationPath, "utf8");
    runPsql(migrationSql);

    // Verify pg_proc after migration: exactly ONE function named attach_workflow_reference_media with 5 arguments
    const procCount = Number(runPsqlScalar(`SELECT count(*) FROM pg_proc WHERE proname = 'attach_workflow_reference_media';`));
    if (procCount !== 1) {
      throw new Error(`Expected exactly 1 function named attach_workflow_reference_media in pg_proc, found: ${procCount}`);
    }
    const procNargs = Number(runPsqlScalar(`SELECT pronargs FROM pg_proc WHERE proname = 'attach_workflow_reference_media';`));
    if (procNargs !== 5) {
      throw new Error(`Expected attach_workflow_reference_media to have pronargs=5, found: ${procNargs}`);
    }
    console.log("   ✔ PASS: Promoted migration applied: exactly ONE function in pg_proc with pronargs=5.");

    // Verify Rollback: restore 4-arg function, verify pg_proc and service_role-only grants
    console.log("   Testing rollback: 20261024000000_add_auto_primary_to_attach_reference_media_rollback.sql...");
    const rollbackPath = path.resolve(import.meta.dirname, "..", "supabase", "rollbacks", "20261024000000_add_auto_primary_to_attach_reference_media_rollback.sql");
    if (!fs.existsSync(rollbackPath)) {
      throw new Error(`Rollback file missing: ${rollbackPath}`);
    }
    const rollbackSql = fs.readFileSync(rollbackPath, "utf8");
    runPsql(rollbackSql);

    const rbProcCount = Number(runPsqlScalar(`SELECT count(*) FROM pg_proc WHERE proname = 'attach_workflow_reference_media';`));
    if (rbProcCount !== 1) {
      throw new Error(`Expected exactly 1 function named attach_workflow_reference_media after rollback, found: ${rbProcCount}`);
    }
    const rbProcNargs = Number(runPsqlScalar(`SELECT pronargs FROM pg_proc WHERE proname = 'attach_workflow_reference_media';`));
    if (rbProcNargs !== 4) {
      throw new Error(`Expected 4-arg function after rollback, found: ${rbProcNargs}`);
    }
    const rbGrants = runPsqlScalar(`
      SELECT anon || '|' || authenticated || '|' || service_role
      FROM (
        SELECT has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
               has_function_privilege('service_role', p.oid, 'execute') as service_role
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'attach_workflow_reference_media'
      ) sub;
    `);
    if (rbGrants !== "false|false|true") {
      throw new Error(`Expected rollback grants false|false|true (anon=false, authenticated=false, service_role=true), got: ${rbGrants}`);
    }
    console.log("   Rollback Grants Table:");
    const rbTable = runPsqlTable(`
      select p.oid::regprocedure as signature,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'attach_workflow_reference_media';
    `);
    console.log(rbTable);
    console.log("   ✔ PASS: Rollback restored 4-arg function with service_role-only grants (pg_proc: count=1, pronargs=4, anon=false, authenticated=false, service_role=true).\n");

    // Re-apply promoted migration to proceed with scenarios testing the 5-arg RPC
    console.log("   Re-applying promoted migration for 5-arg test scenarios...");
    runPsql(migrationSql);
    const reProcCount = Number(runPsqlScalar(`SELECT count(*) FROM pg_proc WHERE proname = 'attach_workflow_reference_media';`));
    const reProcNargs = Number(runPsqlScalar(`SELECT pronargs FROM pg_proc WHERE proname = 'attach_workflow_reference_media';`));
    if (reProcCount !== 1 || reProcNargs !== 5) {
      throw new Error(`Expected 1 function with 5 args after re-applying migration, got count=${reProcCount}, nargs=${reProcNargs}`);
    }
    const reGrants = runPsqlScalar(`
      SELECT anon || '|' || authenticated || '|' || service_role
      FROM (
        SELECT has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
               has_function_privilege('service_role', p.oid, 'execute') as service_role
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'attach_workflow_reference_media'
      ) sub;
    `);
    if (reGrants !== "false|false|true") {
      throw new Error(`Expected promoted migration grants false|false|true (anon=false, authenticated=false, service_role=true), got: ${reGrants}`);
    }
    console.log("   Promoted Migration Grants Table (Post-Migration):");
    const reTable = runPsqlTable(`
      select p.oid::regprocedure as signature,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'attach_workflow_reference_media';
    `);
    console.log(reTable);
    console.log("   ✔ PASS: Promoted migration re-applied; 5-arg RPC active with service_role-only grants (pg_proc: count=1, pronargs=5, anon=false, authenticated=false, service_role=true).\n");

    // -------------------------------------------------------------------------
    // TEST SCENARIOS
    // -------------------------------------------------------------------------

    // SCENARIO 1: Role permission boundary (least privilege)
    console.log("► SCENARIO 1: Least Privilege - anon and authenticated must be rejected (42501)");
    let deniedCount = 0;
    try {
      runPsql(`SET ROLE authenticated; SELECT public.attach_workflow_reference_media('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'detail', 6, false);`);
    } catch (err) {
      if (err.message.includes("permission denied for function attach_workflow_reference_media")) {
        deniedCount++;
      }
    }
    try {
      runPsql(`SET ROLE authenticated; SELECT public.unlink_workflow_media_and_reap_orphan('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');`);
    } catch (err) {
      if (err.message.includes("permission denied for function unlink_workflow_media_and_reap_orphan")) {
        deniedCount++;
      }
    }
    try {
      runPsql(`SET ROLE anon; SELECT public.attach_workflow_reference_media('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'detail', 6, false);`);
    } catch (err) {
      if (err.message.includes("permission denied for function attach_workflow_reference_media")) {
        deniedCount++;
      }
    }
    try {
      runPsql(`SET ROLE anon; SELECT public.unlink_workflow_media_and_reap_orphan('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000');`);
    } catch (err) {
      if (err.message.includes("permission denied for function unlink_workflow_media_and_reap_orphan")) {
        deniedCount++;
      }
    }
    if (deniedCount !== 4) throw new Error(`Expected 4 denials for anon/authenticated, got: ${deniedCount}`);
    console.log("  ✔ PASS: Direct execution by anon and authenticated denied with SQLSTATE 42501");

    // SCENARIO 2: Attachment Idempotency, Quota Neutrality, and Post-Operation Count Accuracy
    console.log("\n► SCENARIO 2: Attachment Idempotency, Quota Neutrality & Accurate current_count");
    const wf1 = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Test Workflow 1') RETURNING id;`, "service_role");
    
    // 2.1: First attachment (M0)
    const m0 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/img_0.png') RETURNING id;`, "service_role");
    const res0 = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${m0}', 'detail', 6);`);
    if (res0.current_count !== 1 || res0.is_primary !== true || res0.is_existing !== false) {
      throw new Error(`Expected first attach to return count 1, is_primary true, got: ${JSON.stringify(res0)}`);
    }
    console.log("  ✔ PASS 2.1: First attachment returned current_count=1, is_primary=true");

    // 2.2: Second attachment (M1)
    const m1 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/img_1.png') RETURNING id;`, "service_role");
    const res1 = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${m1}', 'detail', 6);`);
    if (res1.current_count !== 2 || res1.is_primary !== false || res1.is_existing !== false) {
      throw new Error(`Expected second attach to return count 2, is_primary false, got: ${JSON.stringify(res1)}`);
    }
    console.log("  ✔ PASS 2.2: Second attachment returned current_count=2, is_primary=false");

    // 2.3: Idempotent re-attach of primary M0:
    // - Must return current_count=2 (NOT 3!)
    // - Must preserve is_primary=true (NOT toggle to false!)
    // - Must not create duplicate rows
    const res0Reattach = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${m0}', 'detail', 6);`);
    if (res0Reattach.current_count !== 2 || res0Reattach.is_primary !== true || res0Reattach.is_existing !== true) {
      throw new Error(`Expected reattach of M0 to return count 2, is_primary true, got: ${JSON.stringify(res0Reattach)}`);
    }
    console.log("  ✔ PASS 2.3: Idempotent re-attach of primary media returned exact count=2 and preserved is_primary=true");

    // 2.4: Idempotent re-attach of non-primary M1:
    // - Must return current_count=2
    // - Must preserve is_primary=false
    const res1Reattach = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${m1}', 'detail', 6);`);
    if (res1Reattach.current_count !== 2 || res1Reattach.is_primary !== false || res1Reattach.is_existing !== true) {
      throw new Error(`Expected reattach of M1 to return count 2, is_primary false, got: ${JSON.stringify(res1Reattach)}`);
    }
    console.log("  ✔ PASS 2.4: Idempotent re-attach of non-primary media returned exact count=2 and preserved is_primary=false");

    // 2.5: Fill up to quota of 6
    const mediaIds = [m0, m1];
    for (let i = 2; i < 6; i++) {
      const mId = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/img_${i}.png') RETURNING id;`, "service_role");
      mediaIds.push(mId);
      const res = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${mId}', 'detail', 6);`);
      if (res.current_count !== i + 1 || res.is_primary !== false) {
        throw new Error(`Expected attach of M${i} to return count ${i + 1}, got ${JSON.stringify(res)}`);
      }
    }
    console.log("  ✔ PASS 2.5: Filled quota to 6 items; each returned exact post-operation count");

    // 2.6: Re-attach existing media M0 while at quota 6 (must NOT fail quota check!)
    const atQuotaReattach = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${m0}', 'detail', 6);`);
    if (atQuotaReattach.current_count !== 6 || atQuotaReattach.is_primary !== true) {
      throw new Error(`Reattach at quota returned invalid state: ${JSON.stringify(atQuotaReattach)}`);
    }
    console.log("  ✔ PASS 2.6: Idempotent re-attach while at quota=6 does not fail quota check and returns count=6");

    // 2.7: 7th new media item must exceed quota and throw 23514
    const m7 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/img_7.png') RETURNING id;`, "service_role");
    let quotaExceeded = false;
    let quotaErr = null;
    try {
      runPsql(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wf1}', '${m7}', 'detail', 6);`);
    } catch (err) {
      quotaErr = err;
      if (err.message.includes("Maximum 6 reference images allowed")) {
        quotaExceeded = true;
      }
    }
    if (!quotaExceeded) throw new Error("Expected quota limit check violation on 7th attachment");
    const hint27 = extractHint(quotaErr);
    if (hint27 !== "workflow_media_quota_exceeded") {
      throw new Error(`Expected hint 'workflow_media_quota_exceeded' on 2.7, got '${hint27}'`);
    }
    quotaErr.hint = hint27;
    if (!isWorkflowReferenceQuotaError(quotaErr)) {
      throw new Error(`Expected isWorkflowReferenceQuotaError(quotaErr) to be true, got false. Error: ${quotaErr?.message}`);
    }
    console.log("  ✔ PASS 2.7: 7th attachment rejected with SQLSTATE 23514 (check_violation), HINT 'workflow_media_quota_exceeded', and recognized by isWorkflowReferenceQuotaError");

    // SCENARIO 3: Canonical Composite PK, Multi-Role Attach & Zero Auto-Promotion
    console.log("\n► SCENARIO 3: Canonical Composite PK, Multi-Role Attach & Zero Auto-Promotion");
    const wfMulti = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Multi-Role WF') RETURNING id;`, "service_role");
    const mMulti = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/multi_role.png') RETURNING id;`, "service_role");

    // 3.1: Attach mMulti as role='sheet' -> first relation, is_primary = true
    const resSheet = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfMulti}', '${mMulti}', 'sheet', 6);`);
    if (resSheet.current_count !== 1 || resSheet.is_primary !== true || resSheet.is_existing !== false) {
      throw new Error(`Expected sheet attach to return count 1, is_primary true, got: ${JSON.stringify(resSheet)}`);
    }
    console.log("  ✔ PASS 3.1: Attached media as 'sheet', became initial primary cover (count=1, is_primary=true)");

    // 3.2: Attach same mMulti to same workflow as role='detail'
    // Under canonical composite PK (workflow_id, media_id, role), this is a distinct valid relation.
    // Under partial unique index idx_workflow_media_single_primary, is_primary must be false.
    const resDetail = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfMulti}', '${mMulti}', 'detail', 6);`);
    if (resDetail.current_count !== 1 || resDetail.is_primary !== false || resDetail.is_existing !== false) {
      throw new Error(`Expected detail attach to return count 1 (scoped to detail), is_primary false, got: ${JSON.stringify(resDetail)}`);
    }
    const multiRowCount = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfMulti}' AND media_id = '${mMulti}';`, "service_role");
    if (Number(multiRowCount) !== 2) {
      throw new Error(`Expected 2 distinct rows for composite PK (sheet + detail), got: ${multiRowCount}`);
    }
    console.log("  ✔ PASS 3.2: Composite PK (workflow_id, media_id, role) allows same media under 'sheet' and 'detail' (2 rows, exactly 1 primary)");

    // 3.3: Attempt attach with invalid role string -> rejected by workflow_media_role_check (SQLSTATE 23514)
    let invalidRoleRejected = false;
    let roleErr = null;
    try {
      runPsql(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfMulti}', '${mMulti}', 'unsupported_role', 6);`);
    } catch (err) {
      roleErr = err;
      if (err.message.includes("violates check constraint") || err.message.includes("workflow_media_role_check")) {
        invalidRoleRejected = true;
      }
    }
    if (!invalidRoleRejected) {
      throw new Error("Expected invalid role attachment to be rejected by check constraint!");
    }
    const roleHint = extractHint(roleErr);
    if (roleHint) {
      throw new Error(`Expected role check violation to have NO hint, got '${roleHint}'`);
    }
    roleErr.hint = roleHint;
    if (isWorkflowReferenceQuotaError(roleErr)) {
      throw new Error(`Expected isWorkflowReferenceQuotaError(roleErr) to be false for role check violation, got true! Error: ${roleErr?.message}`);
    }
    console.log("  ✔ PASS 3.3: Invalid role string rejected by canonical check constraint (SQLSTATE 23514), has no hint, and NOT recognized as QuotaError");

    // 3.4: Attach second media as 'detail'
    const mOther = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/other_detail.png') RETURNING id;`, "service_role");
    const resOtherDetail = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfMulti}', '${mOther}', 'detail', 6);`);
    if (resOtherDetail.current_count !== 2 || resOtherDetail.is_primary !== false) {
      throw new Error(`Expected detail count 2, got: ${JSON.stringify(resOtherDetail)}`);
    }
    console.log("  ✔ PASS 3.4: Second 'detail' media attached, detail quota count is 2");

    // 3.5: Idempotent re-attach of mMulti as 'detail'
    const resDetailReattach = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfMulti}', '${mMulti}', 'detail', 6);`);
    if (resDetailReattach.current_count !== 2 || resDetailReattach.is_primary !== false || resDetailReattach.is_existing !== true) {
      throw new Error(`Expected idempotent detail re-attach to return count 2, is_existing true, got: ${JSON.stringify(resDetailReattach)}`);
    }
    const finalDetailRowCount = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfMulti}' AND media_id = '${mMulti}' AND role = 'detail';`, "service_role");
    if (Number(finalDetailRowCount) !== 1) {
      throw new Error(`Expected exactly 1 row for detail relation after re-attach, got: ${finalDetailRowCount}`);
    }
    console.log("  ✔ PASS 3.5: Idempotent re-attach preserves existing detail row without duplicates (count=2)");

    // 3.6: Unlink primary relation ('sheet') -> verify ZERO AUTO-PROMOTION (ADR 0006 & ADR 0007)
    const unlinkSheet = runPsqlJson(`SET ROLE service_role; SELECT public.unlink_workflow_media_and_reap_orphan('${wfMulti}', '${mMulti}', 'sheet');`);
    if (unlinkSheet.unlinked !== true || unlinkSheet.was_primary !== true || unlinkSheet.is_orphan !== false) {
      throw new Error(`Expected sheet unlink with was_primary=true, is_orphan=false, got: ${JSON.stringify(unlinkSheet)}`);
    }
    const primaryCount = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfMulti}' AND is_primary = true;`, "service_role");
    if (Number(primaryCount) !== 0) {
      throw new Error(`Expected 0 primary relations after primary deletion (zero auto-promotion invariant violated!), got: ${primaryCount}`);
    }
    const remainingRelationsCount = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfMulti}';`, "service_role");
    if (Number(remainingRelationsCount) !== 2) {
      throw new Error(`Expected 2 detail relations remaining on workflow, got: ${remainingRelationsCount}`);
    }
    console.log("  ✔ PASS 3.6: Primary relation unlinked: was_primary=true, exactly 0 primary rows remain (zero auto-promotion confirmed)");


    // SCENARIO 4: Generic Attachment with p_max_allowed = NULL
    console.log("\n► SCENARIO 4: Generic Attachment with p_max_allowed = NULL");
    const wfGeneric = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Generic WF') RETURNING id;`, "service_role");
    for (let i = 0; i < 8; i++) {
      const gMedia = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/gen_${i}.png') RETURNING id;`, "service_role");
      const gRes = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfGeneric}', '${gMedia}', 'detail', NULL);`);
      if (gRes.current_count !== i + 1 || gRes.max_allowed !== null) {
        throw new Error(`Generic attachment failed at ${i}: ${JSON.stringify(gRes)}`);
      }
    }
    console.log("  ✔ PASS 4.1: Successfully attached 8 items with p_max_allowed=NULL without quota restriction");

    // SCENARIO 5: Shared Media Preservation vs True Orphan Reaping
    console.log("\n► SCENARIO 5: Shared Media Preservation vs True Orphan Reaping");
    const sharedMediaId = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/shared.png') RETURNING id;`, "service_role");
    const wfA = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'WF A') RETURNING id;`, "service_role");
    const wfB = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'WF B') RETURNING id;`, "service_role");

    // Attach shared media to both workflows
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfA}', '${sharedMediaId}', 'detail', 6);`);
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfB}', '${sharedMediaId}', 'detail', 6);`);

    // Unlink from WF A: must NOT be orphan, row in public.media preserved
    const unlinkA = runPsqlJson(`SET ROLE service_role; SELECT public.unlink_workflow_media_and_reap_orphan('${wfA}', '${sharedMediaId}', 'detail');`);
    if (unlinkA.is_orphan !== false || unlinkA.remaining_links !== 1) {
      throw new Error(`Expected is_orphan=false, remaining_links=1, got: ${JSON.stringify(unlinkA)}`);
    }
    const mediaRowStillExists = runPsqlScalar(`SELECT count(*) FROM public.media WHERE id = '${sharedMediaId}';`, "service_role");
    if (Number(mediaRowStillExists) !== 1) {
      throw new Error("Shared media was prematurely deleted from public.media!");
    }
    console.log("  ✔ PASS 5.1: Unlink from WF A preserved shared media in public.media (remaining_links=1, is_orphan=false)");

    // Unlink from WF B (final link): must be orphan, row deleted from public.media
    const unlinkB = runPsqlJson(`SET ROLE service_role; SELECT public.unlink_workflow_media_and_reap_orphan('${wfB}', '${sharedMediaId}', 'detail');`);
    if (unlinkB.is_orphan !== true || unlinkB.remaining_links !== 0 || !unlinkB.storage_url) {
      throw new Error(`Expected is_orphan=true, remaining_links=0, got: ${JSON.stringify(unlinkB)}`);
    }
    const mediaRowDeleted = runPsqlScalar(`SELECT count(*) FROM public.media WHERE id = '${sharedMediaId}';`, "service_role");
    if (Number(mediaRowDeleted) !== 0) {
      throw new Error("Orphan media row was NOT deleted from public.media!");
    }
    console.log("  ✔ PASS 5.2: Final unlink from WF B cleanly reaped media row and returned storage_url for cleanup");

    // SCENARIO 6: Real Multi-Connection Lock Contention
    console.log("\n► SCENARIO 6: Real Multi-Connection Concurrency (Lock Contention)");
    const raceMediaId = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/race.png') RETURNING id;`, "service_role");
    const raceWfA = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Race WF A') RETURNING id;`, "service_role");
    const raceWfB = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Race WF B') RETURNING id;`, "service_role");

    // Initial link to Race WF A
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${raceWfA}', '${raceMediaId}', 'detail', 6);`);

    // Worker 1 holds FOR UPDATE on public.media in transaction for 1.5 seconds, then unlinks and commits
    const session1 = spawn("psql", ["-d", "postgres", "-X", "-q", "-c", `
      SET ROLE service_role;
      BEGIN;
      SELECT id FROM public.media WHERE id = '${raceMediaId}' FOR UPDATE;
      SELECT pg_sleep(1.5);
      SELECT public.unlink_workflow_media_and_reap_orphan('${raceWfA}', '${raceMediaId}', 'detail');
      COMMIT;
    `], {
      env: { ...process.env, PGUSER: "postgres", PGPORT: String(PG_PORT), PGHOST: "127.0.0.1" },
    });

    // Wait 200ms to ensure Worker 1 is inside transaction holding FOR UPDATE lock
    await new Promise(r => setTimeout(r, 200));

    // Worker 2 attempts attach_workflow_reference_media to Race WF B
    // Because Worker 1 holds FOR UPDATE, Worker 2's FOR KEY SHARE will wait!
    // When Worker 1 commits the reap, media is gone, so Worker 2 receives P0002 Media not found!
    const worker2Start = Date.now();
    let worker2Error = null;
    try {
      runPsql(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${raceWfB}', '${raceMediaId}', 'detail', 6);`);
    } catch (err) {
      worker2Error = err.message;
    }
    const worker2Duration = Date.now() - worker2Start;

    await new Promise((resolve) => session1.on("close", resolve));

    if (worker2Duration < 1000) {
      throw new Error(`Worker 2 did not block on row lock! Duration: ${worker2Duration}ms`);
    }
    if (!worker2Error || !worker2Error.includes("not found")) {
      throw new Error(`Expected Worker 2 to fail with Media not found after reap, got: ${worker2Error}`);
    }

    console.log(`  Worker 2 blocked for ${worker2Duration}ms on FOR UPDATE lock`);
    console.log("  ✔ PASS 6.1: Row lock serialization strictly prevented concurrent attach from resurrecting a reaped orphan");

    // PASS 6.2: Race B (Attachment Wins / Pre-emptive attach preserves shared media)
    const raceMedia2Id = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/race2.png') RETURNING id;`, "service_role");
    const race2WfA = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Race 2 WF A') RETURNING id;`, "service_role");
    const race2WfB = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Race 2 WF B') RETURNING id;`, "service_role");

    // Initially linked only to Race 2 WF A
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${race2WfA}', '${raceMedia2Id}', 'detail', 6);`);

    // Worker A begins transaction, attaches media to Race 2 WF B, and sleeps 2 seconds before committing
    const sessionAttach = spawn("psql", ["-d", "postgres", "-X", "-q", "-c", `
      SET ROLE service_role;
      BEGIN;
      SELECT public.attach_workflow_reference_media('${race2WfB}', '${raceMedia2Id}', 'detail', 6);
      SELECT pg_sleep(2.0);
      COMMIT;
    `], {
      env: { ...process.env, PGUSER: "postgres", PGPORT: String(PG_PORT), PGHOST: "127.0.0.1" },
    });

    // Wait 200ms to ensure Worker A is holding lock inside transaction
    await new Promise(r => setTimeout(r, 200));

    // Worker B attempts unlink of Race 2 WF A
    // Because Worker A holds row lock from attach, Worker B's FOR UPDATE in unlink will wait!
    const workerBStart = Date.now();
    const unlinkRaceResult = runPsqlJson(`SET ROLE service_role; SELECT public.unlink_workflow_media_and_reap_orphan('${race2WfA}', '${raceMedia2Id}', 'detail');`);
    const workerBDuration = Date.now() - workerBStart;

    await new Promise((resolve) => sessionAttach.on("close", resolve));

    if (workerBDuration < 400) {
      throw new Error(`Worker B did not block on row lock! Duration: ${workerBDuration}ms`);
    }
    if (unlinkRaceResult.is_orphan !== false || unlinkRaceResult.remaining_links !== 1) {
      throw new Error(`Expected is_orphan=false, remaining_links=1 after concurrent attach won, got: ${JSON.stringify(unlinkRaceResult)}`);
    }
    const media2Exists = runPsqlScalar(`SELECT count(*) FROM public.media WHERE id = '${raceMedia2Id}';`, "service_role");
    if (Number(media2Exists) !== 1) {
      throw new Error("Shared media was incorrectly reaped when concurrent attach committed!");
    }

    console.log(`  Worker B blocked for ${workerBDuration}ms on FOR UPDATE lock`);
    console.log("  ✔ PASS 6.2: Concurrent attach serialization successfully preserved media from concurrent unlink");

    // PASS 6.3: Concurrent Attach Quota Race (Two workers race to fill the last available slot)
    console.log("► SCENARIO 6.3: Concurrent Attach Quota Race (Two workers race for the last slot)");
    const raceQuotaWf = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Quota Race WF') RETURNING id;`, "service_role");
    // Pre-fill 5 items
    for (let i = 0; i < 5; i++) {
      const mId = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/quota_prefill_${i}.png') RETURNING id;`, "service_role");
      runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${raceQuotaWf}', '${mId}', 'detail', 6);`);
    }
    const preCount = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${raceQuotaWf}';`, "service_role");
    if (Number(preCount) !== 5) throw new Error(`Expected 5 prefilled items, got: ${preCount}`);

    const raceM6 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/race_m6.png') RETURNING id;`, "service_role");
    const raceM7 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/race_m7.png') RETURNING id;`, "service_role");

    // Worker A runs attach in transaction with 1 second delay while holding workflow lock
    const sessionQuotaA = spawn("psql", ["-d", "postgres", "-X", "-q", "-c", `
      SET ROLE service_role;
      BEGIN;
      SELECT public.attach_workflow_reference_media('${raceQuotaWf}', '${raceM6}', 'detail', 6);
      SELECT pg_sleep(1.0);
      COMMIT;
    `], {
      env: { ...process.env, PGUSER: "postgres", PGPORT: String(PG_PORT), PGHOST: "127.0.0.1" },
    });

    await new Promise(r => setTimeout(r, 200));

    // Worker B attempts attach of raceM7 (must wait for Worker A's lock, then fail quota check)
    let workerBQuotaError = null;
    try {
      runPsql(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${raceQuotaWf}', '${raceM7}', 'detail', 6);`);
    } catch (err) {
      workerBQuotaError = err;
    }

    await new Promise((resolve) => sessionQuotaA.on("close", resolve));

    if (!workerBQuotaError) {
      throw new Error("Expected Worker B to fail quota limit check when Worker A fills the 6th slot!");
    }
    const hint63 = extractHint(workerBQuotaError);
    if (hint63 !== "workflow_media_quota_exceeded") {
      throw new Error(`Expected hint 'workflow_media_quota_exceeded' on 6.3, got '${hint63}'`);
    }
    workerBQuotaError.hint = hint63;
    if (!isWorkflowReferenceQuotaError(workerBQuotaError)) {
      throw new Error(`Expected Worker B error to be recognized as QuotaError, got: ${workerBQuotaError?.message}`);
    }

    const postQuotaCount = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${raceQuotaWf}';`, "service_role");
    if (Number(postQuotaCount) !== 6) {
      throw new Error(`Expected exactly 6 items in workflow_media after race, got: ${postQuotaCount}`);
    }
    console.log("  ✔ PASS 6.3: Concurrent attach serialized on workflow row lock: winner reached limit (6), loser cleanly rejected by quota check (23514)");

    // SCENARIO 7: Exact Role vs Wildcard (p_role IS NULL) Unlink Semantics
    console.log("\n► SCENARIO 7: Exact Role vs Wildcard (p_role IS NULL) Unlink Semantics");
    const wfUnlinkSemantics = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Unlink Semantics WF') RETURNING id;`, "service_role");
    const multiRoleMedia = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/multirole.png') RETURNING id;`, "service_role");

    // Seed two roles for the same workflow and media:
    // 1. role = 'sheet', is_primary = true
    // 2. role = 'detail', is_primary = false
    runPsql(`
      INSERT INTO public.workflow_media (workflow_id, media_id, role, is_primary)
      VALUES
        ('${wfUnlinkSemantics}', '${multiRoleMedia}', 'sheet', true),
        ('${wfUnlinkSemantics}', '${multiRoleMedia}', 'detail', false);
    `, "service_role");

    // 7.1: Call unlink with p_role = 'detail' (CharacterMediaService.removeDetailMedia pattern)
    // - Must unlink ONLY the 'detail' relation
    // - Must preserve the 'sheet' relation
    // - was_primary must be false (because only detail was deleted, not the primary sheet)
    // - is_orphan must be false (sheet relation still exists)
    // - remaining_links must be 1
    // - media row in public.media must NOT be deleted
    const unlinkDetailOnly = runPsqlJson(`SET ROLE service_role; SELECT public.unlink_workflow_media_and_reap_orphan('${wfUnlinkSemantics}', '${multiRoleMedia}', 'detail');`);
    if (unlinkDetailOnly.unlinked !== true || unlinkDetailOnly.is_orphan !== false || unlinkDetailOnly.remaining_links !== 1 || unlinkDetailOnly.was_primary !== false) {
      throw new Error(`Expected detail-only unlink to preserve sheet, got: ${JSON.stringify(unlinkDetailOnly)}`);
    }
    const remainingSheetRow = runPsqlJson(`SELECT row_to_json(t) FROM (SELECT role, is_primary FROM public.workflow_media WHERE workflow_id = '${wfUnlinkSemantics}' AND media_id = '${multiRoleMedia}') t;`, "service_role");
    if (remainingSheetRow.role !== "sheet" || remainingSheetRow.is_primary !== true) {
      throw new Error(`Expected sheet row to remain intact as primary, got: ${JSON.stringify(remainingSheetRow)}`);
    }
    console.log("  ✔ PASS 7.1: Unlink with p_role = 'detail' deletes detail relation and preserves 'sheet' relation and primary cover");

    // 7.2: Call unlink with p_role = NULL (WorkflowMediaService.deleteMedia / releaseWorkflowMedia pattern)
    // - p_role IS NULL acts as wildcard across all roles for this workflow
    // - Deletes the 'sheet' relation
    // - was_primary must be true (since the sheet relation was primary)
    // - Clears primary flag on the workflow
    // - With zero remaining links across all workflows, is_orphan must be true
    // - media row in public.media must be cleanly reaped
    // - returns storage_url for physical object deletion
    const unlinkWildcard = runPsqlJson(`SET ROLE service_role; SELECT public.unlink_workflow_media_and_reap_orphan('${wfUnlinkSemantics}', '${multiRoleMedia}', NULL);`);
    if (unlinkWildcard.unlinked !== true || unlinkWildcard.is_orphan !== true || unlinkWildcard.remaining_links !== 0 || unlinkWildcard.was_primary !== true || !unlinkWildcard.storage_url) {
      throw new Error(`Expected wildcard unlink to reap orphan, got: ${JSON.stringify(unlinkWildcard)}`);
    }
    const finalMediaCount = runPsqlScalar(`SELECT count(*) FROM public.media WHERE id = '${multiRoleMedia}';`, "service_role");
    if (Number(finalMediaCount) !== 0) {
      throw new Error("Expected media row to be deleted after final wildcard unlink!");
    }
    console.log("  ✔ PASS 7.2: Unlink with p_role IS NULL acts as wildcard for workflow container, detects was_primary=true, and cleanly reaps orphan");

    // SCENARIO 8: Atomic Conditional Primary Media Restore (Zero Overwrite Invariant)
    console.log("\n► SCENARIO 8: Atomic Conditional Primary Media Restore (Zero Overwrite Invariant)");
    const wfCond = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Conditional Restore WF') RETURNING id;`, "service_role");
    const mCondA = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/cond_a.png') RETURNING id;`, "service_role");
    const mCondB = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/cond_b.png') RETURNING id;`, "service_role");

    // Set initial primary to mCondA
    runPsql(`UPDATE public.workflow SET primary_media_id = '${mCondA}' WHERE id = '${wfCond}';`, "service_role");
    const initialPrimary = runPsqlScalar(`SELECT primary_media_id FROM public.workflow WHERE id = '${wfCond}';`, "service_role");
    if (initialPrimary !== mCondA) throw new Error(`Expected primary ${mCondA}, got: ${initialPrimary}`);

    // 8.1: Successful conditional restore: expected matches current primary (returns 1 affected row)
    const restoreSuccessRows = runPsqlJson(`
      WITH updated AS (
        UPDATE public.workflow
        SET primary_media_id = NULL
        WHERE id = '${wfCond}' AND primary_media_id = '${mCondA}'
        RETURNING id, primary_media_id
      )
      SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json) FROM updated;
    `, "service_role");

    if (!Array.isArray(restoreSuccessRows) || restoreSuccessRows.length !== 1) {
      throw new Error(`Expected exactly 1 updated row on matching expected primary, got: ${JSON.stringify(restoreSuccessRows)}`);
    }
    console.log("  ✔ PASS 8.1: Conditional UPDATE matched expected primary, cleared primary, returned 1 affected row");

    // 8.2: Failed conditional restore: expected primary does NOT match (simulates concurrent change)
    // Returns 0 affected rows (empty array [])
    const restoreMismatchedRows = runPsqlJson(`
      WITH updated AS (
        UPDATE public.workflow
        SET primary_media_id = '${mCondB}'
        WHERE id = '${wfCond}' AND primary_media_id = '${mCondA}'
        RETURNING id, primary_media_id
      )
      SELECT COALESCE(json_agg(row_to_json(updated)), '[]'::json) FROM updated;
    `, "service_role");

    if (!Array.isArray(restoreMismatchedRows) || restoreMismatchedRows.length !== 0) {
      throw new Error(`Expected exactly 0 updated rows on mismatched expected primary, got: ${JSON.stringify(restoreMismatchedRows)}`);
    }
    console.log("  ✔ PASS 8.2: Conditional UPDATE rejected stale expected primary (0 affected rows), preserved current DB state");

    // SCENARIO 9: p_auto_primary Parameter Semantics & Invariants
    console.log("\n► SCENARIO 9: p_auto_primary Parameter Semantics & Invariants");
    const wfAutoPri = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'AutoPrimary WF') RETURNING id;`, "service_role");
    const mPri1 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_1.png') RETURNING id;`, "service_role");
    const mPri2 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_2.png') RETURNING id;`, "service_role");
    const mPri3 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_3.png') RETURNING id;`, "service_role");

    // 9.1: p_auto_primary = false on primary-less workflow -> is_primary = false
    const resAutoFalse = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri1}', 'detail', 6, false);`);
    if (resAutoFalse.is_primary !== false || resAutoFalse.current_count !== 1) {
      throw new Error(`Expected is_primary=false when p_auto_primary=false, got: ${JSON.stringify(resAutoFalse)}`);
    }
    const hasAnyPrimary1 = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfAutoPri}' AND is_primary = true;`, "service_role");
    if (Number(hasAnyPrimary1) !== 0) {
      throw new Error(`Expected 0 primary rows in workflow_media when p_auto_primary=false, got: ${hasAnyPrimary1}`);
    }
    console.log("  ✔ PASS 9.1: p_auto_primary=false on primary-less workflow attaches with is_primary=false");

    // 9.2: p_auto_primary = NULL -> behaves as default true (is_primary = true since workflow still has no primary)
    const resAutoNull = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri2}', 'detail', 6, NULL);`);
    if (resAutoNull.is_primary !== true || resAutoNull.current_count !== 2) {
      throw new Error(`Expected is_primary=true when p_auto_primary=NULL (COALESCE to default true), got: ${JSON.stringify(resAutoNull)}`);
    }
    const hasAnyPrimary2 = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfAutoPri}' AND is_primary = true;`, "service_role");
    if (Number(hasAnyPrimary2) !== 1) {
      throw new Error(`Expected exactly 1 primary row in workflow_media after p_auto_primary=NULL attach, got: ${hasAnyPrimary2}`);
    }
    console.log("  ✔ PASS 9.2: p_auto_primary=NULL coalesces to default true (became primary on workflow without existing primary)");

    // 9.3: p_auto_primary = false on workflow with existing primary -> is_primary = false
    const resAutoFalseWithExisting = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri3}', 'detail', 6, false);`);
    if (resAutoFalseWithExisting.is_primary !== false || resAutoFalseWithExisting.current_count !== 3) {
      throw new Error(`Expected is_primary=false on attach with existing primary, got: ${JSON.stringify(resAutoFalseWithExisting)}`);
    }
    console.log("  ✔ PASS 9.3: p_auto_primary=false on workflow with existing primary results in is_primary=false");

    // 9.4: Idempotent re-attach with false preserves existing is_primary
    // 9.4a: Re-attaching mPri2 (which is primary) with false preserves is_primary=true
    const reattachPri2 = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri2}', 'detail', 6, false);`);
    if (reattachPri2.is_primary !== true || reattachPri2.is_existing !== true || reattachPri2.current_count !== 3) {
      throw new Error(`Expected idempotent re-attach with false to preserve is_primary=true, got: ${JSON.stringify(reattachPri2)}`);
    }
    // 9.4b: Re-attaching mPri1 (which is non-primary) with false preserves is_primary=false
    const reattachPri1 = runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri1}', 'detail', 6, false);`);
    if (reattachPri1.is_primary !== false || reattachPri1.is_existing !== true || reattachPri1.current_count !== 3) {
      throw new Error(`Expected idempotent re-attach with false to preserve is_primary=false, got: ${JSON.stringify(reattachPri1)}`);
    }
    console.log("  ✔ PASS 9.4: Idempotent re-attach with false preserves existing is_primary state (both true and false)");

    // 9.5: Quota 23514 unchanged with false (fill up to quota and assert check violation)
    const mPri4 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_4.png') RETURNING id;`, "service_role");
    const mPri5 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_5.png') RETURNING id;`, "service_role");
    const mPri6 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_6.png') RETURNING id;`, "service_role");
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri4}', 'detail', 6, false);`);
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri5}', 'detail', 6, false);`);
    runPsqlJson(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri6}', 'detail', 6, false);`);
    const countAtQuota = runPsqlScalar(`SELECT count(*) FROM public.workflow_media WHERE workflow_id = '${wfAutoPri}';`, "service_role");
    if (Number(countAtQuota) !== 6) throw new Error(`Expected 6 items at quota, got: ${countAtQuota}`);

    const mPri7 = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/pri_7.png') RETURNING id;`, "service_role");
    let quotaExceededFalse = false;
    let quotaErr95 = null;
    try {
      runPsql(`SET ROLE service_role; SELECT public.attach_workflow_reference_media('${wfAutoPri}', '${mPri7}', 'detail', 6, false);`);
    } catch (err) {
      quotaErr95 = err;
      if (err.message.includes("Maximum 6 reference images allowed")) quotaExceededFalse = true;
    }
    if (!quotaExceededFalse) throw new Error("Expected quota 23514 to be raised on 7th attachment with p_auto_primary=false");
    const hint95 = extractHint(quotaErr95);
    if (hint95 !== "workflow_media_quota_exceeded") {
      throw new Error(`Expected hint 'workflow_media_quota_exceeded' on 9.5, got '${hint95}'`);
    }
    quotaErr95.hint = hint95;
    if (!isWorkflowReferenceQuotaError(quotaErr95)) {
      throw new Error(`Expected 9.5 error to be recognized as QuotaError, got: ${quotaErr95?.message}`);
    }
    console.log("  ✔ PASS 9.5: Quota enforcement (23514) identical with HINT 'workflow_media_quota_exceeded' and unaffected by p_auto_primary=false");

    // 9.6: Return jsonb keys identical across 4-arg and 5-arg calls, including current_count
    const expectedKeys = ["current_count", "is_existing", "is_primary", "max_allowed", "media_id", "role", "workflow_id"];
    const actualKeys = Object.keys(resAutoFalse).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`JSON keys mismatch! Expected ${JSON.stringify(expectedKeys)}, got: ${JSON.stringify(actualKeys)}`);
    }
    console.log("  ✔ PASS 9.6: Return jsonb keys identical: " + JSON.stringify(expectedKeys));

    // 9.7: Calling with 4 named parameters is NOT ambiguous and succeeds, defaulting p_auto_primary to true
    const wfNamed = runPsqlScalar(`INSERT INTO public.workflow (user_id, project_id, title) VALUES (gen_random_uuid(), gen_random_uuid(), 'Named Params WF') RETURNING id;`, "service_role");
    const mNamed = runPsqlScalar(`INSERT INTO public.media (url) VALUES ('https://storage.test/named.png') RETURNING id;`, "service_role");
    const resNamed = runPsqlJson(`
      SET ROLE service_role;
      SELECT public.attach_workflow_reference_media(
        p_workflow_id := '${wfNamed}',
        p_media_id := '${mNamed}',
        p_role := 'detail',
        p_max_allowed := 6
      );
    `);
    if (resNamed.is_primary !== true || resNamed.current_count !== 1) {
      throw new Error(`Named param call failed or did not default auto_primary to true: ${JSON.stringify(resNamed)}`);
    }
    console.log("  ✔ PASS 9.7: 4-named-parameter call is not ambiguous and defaults p_auto_primary to true");

    console.log("\n================================================================================");
    console.log("  ALL REAL POSTGRESQL CONCURRENCY & INTEGRATION SCENARIOS PASSED (100% SUCCESS)");
    console.log("================================================================================");

  } finally {
    // Teardown ephemeral postgres
    console.log("\nTearing down isolated PostgreSQL cluster...");
    try {
      execFileSync("pg_ctl", ["-D", TEMP_DATA_DIR, "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {}
    try {
      fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
    } catch {}
    console.log("Cleaned up temporary cluster data.\n");
  }
}

main().catch(err => {
  console.error("\n❌ TEST SUITE FAILED:", err);
  process.exit(1);
});
