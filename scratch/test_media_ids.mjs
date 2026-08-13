import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkMediaIds() {
  const mediaIds = [
    "2a31b94e-81d3-4ac2-ae84-fd860caa2579",
    "4116167a-ad9d-47ac-8db7-2174a493cc65",
    "bdf82a8e-d79d-4630-901e-d657bbb972cc",
    "fee1fd76-5655-49f4-876d-b689248f40a6"
  ];

  const { data: rows, error } = await supabase
    .from("media")
    .select("*")
    .in("id", mediaIds);

  console.log("Media rows by IDs:", rows);
  console.log("Error:", error);

  // Also query recent media rows across all projects
  const { data: recentMedia } = await supabase
    .from("media")
    .select("id, project_id, workflow_id, url, status, create_time")
    .order("create_time", { ascending: false })
    .limit(10);

  console.log("\nRecent 10 media rows in DB:", recentMedia);

  process.exit(0);
}

checkMediaIds().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
