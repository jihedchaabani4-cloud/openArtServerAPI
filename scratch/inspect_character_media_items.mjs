import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function inspectMedia() {
  const workflowId = "d36365ef-ce79-41e4-88ad-0fd20dcff24c";
  const { data: mediaRows, error } = await supabase
    .from("media")
    .select("*")
    .eq("workflow_id", workflowId);

  console.log("🔍 Media items for workflow", workflowId, ":");
  console.log(JSON.stringify(mediaRows, null, 2));
}

inspectMedia().catch(console.error);
