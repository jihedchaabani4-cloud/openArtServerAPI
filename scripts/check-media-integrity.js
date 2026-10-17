/**
 * Runnable database integrity check: finds all media rows with no workflow_media link.
 *
 * Usage:
 *   node scripts/check-media-integrity.js
 *
 * Safety:
 *   100% READ-ONLY. Never modifies or deletes any database record.
 *   Paginates PostgREST requests in batches of 1000 to avoid truncation.
 */

import "dotenv/config";
import { supabaseAdmin, supabase } from "../lib/supabase.js";

const PAGE_SIZE = 1000;

async function fetchAll(client, table, columns, orderBy = null) {
  const rows = [];
  let from = 0;

  while (true) {
    let query = client
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);

    if (orderBy) {
      query = query.order(orderBy, { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to query ${table} [range ${from}..${from + PAGE_SIZE - 1}]: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    rows.push(...data);
    if (data.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  return rows;
}

async function runCheck() {
  const client = supabaseAdmin || supabase;
  if (!client) {
    console.error("Error: Supabase client could not be initialized.");
    process.exit(1);
  }

  console.log("Checking database integrity: media rows without workflow_media link...\n");

  // 1. Fetch all media rows (paginated)
  const mediaRows = await fetchAll(
    client,
    "media",
    "id, project_id, step_id, status, url, create_time",
    "create_time"
  );

  // 2. Fetch all workflow_media links (paginated)
  const wmRows = await fetchAll(
    client,
    "workflow_media",
    "workflow_id, media_id, role"
  );

  const linkedMediaIds = new Set(wmRows.map((r) => r.media_id));

  // 3. Find unlinked rows
  const unlinked = mediaRows.filter((m) => !linkedMediaIds.has(m.id));

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
