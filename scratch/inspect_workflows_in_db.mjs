import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function inspectWorkflows() {
  const ids = ["2aca06a0-a45b-4543-a0ed-31a62bd8733a", "06297fb0-ab9d-41ab-8748-72a7c17b46cb"];

  console.log("\n🔍 Inspecting DB records for workflows...");

  const { data: workflows, error: wfErr } = await supabase
    .from("workflow")
    .select("*")
    .in("id", ids);

  console.log("📌 Workflow DB records:");
  console.log(JSON.stringify(workflows, null, 2));

  const { data: elements, error: elemErr } = await supabase
    .from("element")
    .select("*")
    .in("workflow_id", ids);

  console.log("📌 Element DB records:");
  console.log(JSON.stringify(elements, null, 2));
}

inspectWorkflows().catch(console.error);
