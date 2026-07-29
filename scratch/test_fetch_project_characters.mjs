import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function checkProjectWorkflows() {
  console.log("\n=======================================================");
  console.log("🔍 CHECKING DATABASE WORKFLOWS & CHARACTERS");
  console.log("=======================================================\n");

  // 1. Fetch all workflows
  const { data: workflows, error: wfErr } = await supabase
    .from("workflow")
    .select("id, project_id, display_name, workflow_type, create_time");

  if (wfErr) {
    console.error("❌ Error fetching workflows:", wfErr);
    process.exit(1);
  }

  console.log(`📌 Total Workflows in DB: ${workflows?.length || 0}`);
  console.table(workflows);

  // 2. Fetch all elements
  const { data: elements, error: elemErr } = await supabase
    .from("element")
    .select("id, workflow_id, name, element_type, create_time");

  if (elemErr) {
    console.error("❌ Error fetching elements:", elemErr);
  } else {
    console.log(`\n📌 Total Elements in DB: ${elements?.length || 0}`);
    console.table(elements);
  }

  // 3. Group workflows by project_id and workflow_type
  const projectsSummary = {};
  for (const wf of workflows || []) {
    const pid = wf.project_id || "NO_PROJECT";
    if (!projectsSummary[pid]) projectsSummary[pid] = [];
    projectsSummary[pid].push({ id: wf.id, type: wf.workflow_type, name: wf.display_name });
  }

  console.log("\n📊 Summary by Project ID:");
  console.log(JSON.stringify(projectsSummary, null, 2));

  console.log("\n=======================================================");
}

checkProjectWorkflows().catch(console.error);
