import { supabase } from "./lib/supabase.js";

async function listWorkflows() {
  console.log("🔍 Querying workflow and element tables in Supabase...");
  const { data: workflows, error: wfErr } = await supabase
    .from("workflow")
    .select("id, display_name, project_id, workflow_type");

  if (wfErr) {
    console.error("❌ Error fetching workflows:", wfErr);
    return;
  }

  console.log(`Found ${workflows?.length || 0} total workflows in database:`);
  console.dir(workflows, { depth: null });

  const { data: elements, error: elemErr } = await supabase
    .from("element")
    .select("id, workflow_id, name, description, keywords, guidelines");

  if (elemErr) {
    console.error("❌ Error fetching element records:", elemErr);
    return;
  }

  console.log(`\nFound ${elements?.length || 0} total element records in database:`);
  console.dir(elements, { depth: null });
}

listWorkflows().catch(console.error);
