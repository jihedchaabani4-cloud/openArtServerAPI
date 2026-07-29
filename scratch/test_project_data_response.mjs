import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { getWorkflows } from "../controllers/workflowsController.js";

async function testProjectDataController() {
  const projectId = "40f3810f-960c-4d2b-b1e1-6e6684ed936d";

  console.log(`\n🔍 Querying workflows directly via getWorkflows for project: ${projectId}...`);

  const workflows = await getWorkflows(
    { project_id: projectId },
    {
      select: "id, display_name, variation_index, primary_media_id, create_time, session_id, favorited, workflow_type",
      order: { column: "create_time", ascending: false },
    }
  );

  console.log(`📌 Workflows returned by getWorkflows (${workflows.length}):`);
  console.log(JSON.stringify(workflows, null, 2));

  const { data: mediaItems, error: mediaErr } = await supabase
    .from("media")
    .select("id, workflow_id, url, status, error_message, create_time")
    .eq("project_id", projectId);

  if (mediaErr) console.error("❌ Media error:", mediaErr);
  console.log(`📌 Media items returned (${mediaItems?.length || 0}):`);
  console.log(JSON.stringify(mediaItems, null, 2));
}

testProjectDataController().catch(console.error);
