import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE credentials");
  process.exit(1);
}

const client = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

async function runInventory() {
  const tables = [
    "workflow",
    "media",
    "workflow_media",
    "project",
    "profiles",
    "wallets",
    "transactions",
    "element",
    "characters",
    "folders",
    "v2_workflow_runs",
    "v2_workflow_run_nodes",
    "usage_events"
  ];

  const counts = {};
  for (const table of tables) {
    try {
      const { count, error } = await client
        .from(table)
        .select("*", { count: "exact", head: true });
      counts[table] = error ? `Error: ${error.message}` : count;
    } catch (e) {
      counts[table] = `Exception: ${e.message}`;
    }
  }

  // Auth users count
  try {
    const { data: usersData, error: uErr } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    counts["auth.users"] = uErr ? `Error: ${uErr.message}` : (usersData?.users?.length || 0);
    counts["auth.users_details"] = usersData?.users?.map(u => ({ id: u.id, email: u.email, created_at: u.created_at })) || [];
  } catch (e) {
    counts["auth.users"] = `Exception: ${e.message}`;
  }

  // Storage buckets & objects
  const storage = {};
  try {
    const { data: buckets, error: bErr } = await client.storage.listBuckets();
    if (bErr) {
      storage.error = bErr.message;
    } else {
      storage.buckets = [];
      for (const b of buckets || []) {
        const { data: files, error: fErr } = await client.storage.from(b.id).list("", { limit: 100 });
        storage.buckets.push({
          id: b.id,
          name: b.name,
          public: b.public,
          rootObjectsCount: files ? files.length : 0,
          sampleObjects: files ? files.slice(0, 10).map(f => f.name) : [],
          error: fErr ? fErr.message : null
        });
      }
    }
  } catch (e) {
    storage.error = e.message;
  }

  console.log(JSON.stringify({ liveCounts: counts, liveStorage: storage }, null, 2));
}

runInventory().catch(err => {
  console.error("Inventory failed:", err);
  process.exit(1);
});
