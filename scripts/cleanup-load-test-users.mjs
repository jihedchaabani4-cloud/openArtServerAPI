#!/usr/bin/env node
/**
 * Cleans up all Supabase users, projects, workflows, media, wallets, and transactions
 * created by scripts/load-test-video-5users.mjs.
 *
 * Usage:
 *   node scripts/cleanup-load-test-users.mjs [path-to-manifest.json]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const manifestPath =
  process.argv[2] ||
  path.resolve(process.cwd(), "scripts", ".load-test-video-last-run.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest file not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const users = manifest.users || [];
if (!users.length) {
  console.log("No users in manifest to clean up.");
  process.exit(0);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
);

async function main() {
  console.log(`Cleaning up ${users.length} load-test users from run ${manifest.runTag}...`);

  for (const u of users) {
    const { userId, projectId, walletId, email } = u;

    // 1. Delete workflow_media + media + workflow + project
    const { data: workflows } = await supabaseAdmin
      .from("workflow")
      .select("id")
      .eq("project_id", projectId);
    const wfIds = (workflows || []).map((w) => w.id);

    if (wfIds.length) {
      await supabaseAdmin.from("workflow_media").delete().in("workflow_id", wfIds);
    }
    await supabaseAdmin.from("media").delete().eq("project_id", projectId);
    if (wfIds.length) {
      await supabaseAdmin.from("workflow").delete().in("id", wfIds);
    }
    await supabaseAdmin.from("project").delete().eq("id", projectId);

    // 2. Delete billing transactions + usage_events + wallet
    if (walletId) {
      await supabaseAdmin.from("transactions").delete().eq("wallet_id", walletId);
      await supabaseAdmin.from("wallets").delete().eq("id", walletId);
    }
    await supabaseAdmin.from("usage_events").delete().eq("user_id", userId);

    // 3. Delete Supabase Auth user
    const { error: delUserErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (delUserErr) {
      console.warn(`  [WARN] Could not delete auth user ${email} (${userId}): ${delUserErr.message}`);
    } else {
      console.log(`  [OK] Deleted user ${email} (${userId}), project ${projectId}, and wallet ${walletId}`);
    }
  }

  console.log("Cleanup complete.");
}

main().catch((err) => {
  console.error("[CLEANUP FAILED]", err);
  process.exit(1);
});
