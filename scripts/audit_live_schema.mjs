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

const candidateTables = [
  "project",
  "session",
  "workflow",
  "media",
  "batch",
  "generation_config",
  "generation_config_reference",
  "dna",
  "profiles",
  "wallets",
  "transactions",
  "credit_packages",
  "v2_workflow_runs",
  "v2_workflow_run_nodes",
  "provider_calls",
  "characters",
  "element",
  "folders",
  "workflow_media",
  "usage_events",
  "schema_migrations",
  "_prisma_migrations"
];

async function inspectSchema() {
  const results = {};

  for (const table of candidateTables) {
    try {
      const { data, count, error } = await client
        .from(table)
        .select("*", { count: "exact" })
        .limit(1);

      if (error) {
        results[table] = {
          exists: false,
          error: error.message,
          code: error.code
        };
      } else {
        const columns = data && data.length > 0 ? Object.keys(data[0]) : [];
        results[table] = {
          exists: true,
          count,
          sampleColumns: columns,
          sampleRow: data && data.length > 0 ? data[0] : null
        };
      }
    } catch (e) {
      results[table] = {
        exists: false,
        exception: e.message
      };
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

inspectSchema().catch(err => {
  console.error("Schema inspection error:", err);
  process.exit(1);
});
