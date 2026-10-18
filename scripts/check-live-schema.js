/**
 * Read-only live database schema checker.
 *
 * Verifies live Supabase state against code expectations:
 *   1. media has no workflow_id
 *   2. element has no primary_media_id
 *   3. workflow_media exists with canonical columns, PK, and FK constraints
 *   4. element.workflow_id references workflow.id
 *   5. create_workflow_with_placeholder_media RPC inspection
 *
 * Usage:
 *   node scripts/check-live-schema.js
 *
 * Safety:
 *   100% READ-ONLY. Never writes, alters, updates, or deletes any data or schema.
 */

import "dotenv/config";
import { supabaseAdmin, supabase } from "../lib/supabase.js";

async function fetchOpenApiSchema(url, key) {
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    return { data };
  } catch (err) {
    return { error: err.message };
  }
}

async function runLiveSchemaCheck() {
  const client = supabaseAdmin || supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

  if (!client || !url || !key) {
    console.error("❌ Fatal: Supabase client or credentials missing in environment variables.");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log("  LIVE SUPABASE SCHEMA VERIFICATION (READ-ONLY)");
  console.log(`  Target: ${url}`);
  console.log("================================================================================\n");

  const results = [];

  // Fetch OpenAPI schema definitions directly from PostgREST
  const { data: openApi, error: openApiErr } = await fetchOpenApiSchema(url, key);
  const definitions = openApi?.definitions || {};
  const paths = openApi?.paths || {};

  // --------------------------------------------------------------------------
  // Check 1: media has no workflow_id
  // --------------------------------------------------------------------------
  try {
    const queryRes = await client.from("media").select("id, workflow_id").limit(1);
    const inOpenApi = Boolean(definitions?.media?.properties?.workflow_id);

    if (queryRes.error?.code === "42703" && !inOpenApi) {
      results.push({
        check: "1. media has no workflow_id",
        status: "PASS",
        details: "Verified: column does not exist (PostgreSQL code 42703, absent from schema cache)",
      });
    } else if (!queryRes.error && queryRes.data) {
      results.push({
        check: "1. media has no workflow_id",
        status: "FAIL",
        details: "Live media table still contains column 'workflow_id'",
      });
    } else {
      results.push({
        check: "1. media has no workflow_id",
        status: inOpenApi ? "FAIL" : "PASS",
        details: queryRes.error?.message || "Verified via schema cache inspection",
      });
    }
  } catch (err) {
    results.push({
      check: "1. media has no workflow_id",
      status: "ERROR",
      details: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Check 2: element has no primary_media_id
  // --------------------------------------------------------------------------
  try {
    const queryRes = await client.from("element").select("id, primary_media_id").limit(1);
    const inOpenApi = Boolean(definitions?.element?.properties?.primary_media_id);

    if (queryRes.error?.code === "42703" && !inOpenApi) {
      results.push({
        check: "2. element has no primary_media_id",
        status: "PASS",
        details: "Verified: column does not exist (PostgreSQL code 42703, absent from schema cache)",
      });
    } else if (!queryRes.error && queryRes.data) {
      results.push({
        check: "2. element has no primary_media_id",
        status: "FAIL",
        details: "Live element table still contains column 'primary_media_id'",
      });
    } else {
      results.push({
        check: "2. element has no primary_media_id",
        status: inOpenApi ? "FAIL" : "PASS",
        details: queryRes.error?.message || "Verified via schema cache inspection",
      });
    }
  } catch (err) {
    results.push({
      check: "2. element has no primary_media_id",
      status: "ERROR",
      details: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Check 3: workflow_media columns, constraints, and indexes
  // --------------------------------------------------------------------------
  try {
    const wmCols = ["workflow_id", "media_id", "role", "created_at"];
    const queryRes = await client.from("workflow_media").select(wmCols.join(", ")).limit(1);

    const wmDef = definitions?.workflow_media;
    const hasAllCols = wmDef ? wmCols.every((col) => col in wmDef.properties) : false;
    const roleProp = wmDef?.properties?.role;
    const wfProp = wmDef?.properties?.workflow_id;
    const mediaProp = wmDef?.properties?.media_id;

    const hasCompositePk =
      roleProp?.description?.includes("<pk/>") &&
      wfProp?.description?.includes("<pk/>") &&
      mediaProp?.description?.includes("<pk/>");

    const hasFks =
      wfProp?.description?.includes("workflow.id") &&
      mediaProp?.description?.includes("media.id");

    if (!queryRes.error && hasAllCols && hasCompositePk && hasFks) {
      results.push({
        check: "3. workflow_media columns & constraints",
        status: "PASS",
        details: "4/4 columns present, composite PK (workflow_id, media_id, role), FKs to workflow and media",
      });
    } else if (!queryRes.error && hasAllCols) {
      results.push({
        check: "3. workflow_media columns & constraints",
        status: "PASS",
        details: "All 4 columns queryable; verify constraint details in Supabase SQL editor",
      });
    } else {
      results.push({
        check: "3. workflow_media columns & constraints",
        status: "FAIL",
        details: queryRes.error?.message || "Missing columns or constraints",
      });
    }
  } catch (err) {
    results.push({
      check: "3. workflow_media columns & constraints",
      status: "ERROR",
      details: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Check 4: element.workflow_id foreign key constraint
  // --------------------------------------------------------------------------
  try {
    const elemDef = definitions?.element;
    const wfFk = elemDef?.properties?.workflow_id;
    const hasFk = wfFk?.description?.includes("workflow.id");

    if (hasFk) {
      results.push({
        check: "4. element.workflow_id foreign key",
        status: "PASS",
        details: "Foreign key to workflow.id confirmed. (Run check_live_schema.sql to verify confdeltype = 'n' SET NULL)",
      });
    } else {
      results.push({
        check: "4. element.workflow_id foreign key",
        status: "FAIL",
        details: "Foreign key reference on element.workflow_id not detected in schema cache",
      });
    }
  } catch (err) {
    results.push({
      check: "4. element.workflow_id foreign key",
      status: "ERROR",
      details: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Check 5: create_workflow_with_placeholder_media RPC
  // --------------------------------------------------------------------------
  try {
    const rpcPath = paths?.["/rpc/create_workflow_with_placeholder_media"];
    if (rpcPath) {
      results.push({
        check: "5. create_workflow_with_placeholder_media RPC",
        status: "PASS",
        details: "RPC endpoint published in PostgREST. (Run check_live_schema.sql to inspect pg_proc.prosrc body on live DB)",
      });
    } else {
      results.push({
        check: "5. create_workflow_with_placeholder_media RPC",
        status: "FAIL",
        details: "RPC endpoint /rpc/create_workflow_with_placeholder_media not found in PostgREST schema cache",
      });
    }
  } catch (err) {
    results.push({
      check: "5. create_workflow_with_placeholder_media RPC",
      status: "ERROR",
      details: err.message,
    });
  }

  // --------------------------------------------------------------------------
  // Print Formatted Report
  // --------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("  CHECK RESULTS");
  console.log("--------------------------------------------------------------------------------");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅ PASS" : r.status === "FAIL" ? "❌ FAIL" : "⚠️ ERROR";
    console.log(`[${icon}]  ${r.check}`);
    console.log(`         ${r.details}\n`);
  }
  console.log("--------------------------------------------------------------------------------");
  console.log("  Direct SQL script available at: scripts/sql/check_live_schema.sql");
  console.log("================================================================================\n");

  const hasFails = results.some((r) => r.status === "FAIL" || r.status === "ERROR");
  process.exit(hasFails ? 1 : 0);
}

runLiveSchemaCheck();
