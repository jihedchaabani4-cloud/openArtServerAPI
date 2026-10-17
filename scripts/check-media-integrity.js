/**
 * Runnable database integrity check: finds all media rows with no workflow_media link.
 *
 * Usage:
 *   node scripts/check-media-integrity.js
 *
 * Safety:
 *   100% READ-ONLY. Never modifies or deletes any database record.
 */

import "dotenv/config";
import { supabaseAdmin, supabase } from "../lib/supabase.js";

async function runCheck() {
  const client = supabaseAdmin || supabase;
  if (!client) {
    console.error("Error: Supabase client could not be initialized.");
    process.exit(1);
  }

  console.log("Checking database integrity: media rows without workflow_media link...\n");

  // 1. Fetch all media rows
  const { data: mediaRows, error: mediaErr } = await client
    .from("media")
    .select("id, project_id, step_id, status, url, create_time")
    .order("create_time", { ascending: false });

  if (mediaErr) {
    console.error("Failed to query media table:", mediaErr.message);
    process.exit(1);
  }

  // 2. Fetch all workflow_media links
  const { data: wmRows, error: wmErr } = await client
    .from("workflow_media")
    .select("workflow_id, media_id, role");

  if (wmErr) {
    console.error("Failed to query workflow_media table:", wmErr.message);
    process.exit(1);
  }

  const linkedMediaIds = new Set((wmRows || []).map((r) => r.media_id));

  // 3. Find unlinked rows
  const unlinked = (mediaRows || []).filter((m) => !linkedMediaIds.has(m.id));

  if (unlinked.length === 0) {
    console.log("✅ INTEGRITY CHECK PASSED: 0 unlinked media rows found.");
    console.log(`Total media rows: ${mediaRows.length}, Total workflow_media links: ${wmRows.length}`);
    process.exit(0);
  }

  console.warn(`⚠️  FOUND ${unlinked.length} UNLINKED MEDIA ROW(S):\n`);
  for (const row of unlinked) {
    console.log({
      media_id: row.id,
      step_id: row.step_id,
      status: row.status,
      has_url: Boolean(row.url),
      project_id: row.project_id,
      create_time: row.create_time,
    });
  }

  console.log(`\nTotal media rows: ${mediaRows.length}`);
  console.log(`Total workflow_media links: ${wmRows.length}`);
  console.log(`Unlinked count: ${unlinked.length}`);
}

runCheck().catch((err) => {
  console.error("Integrity check failed:", err.message);
  process.exit(1);
});
