import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function checkWorkflowById() {
  const wfId = "2d31c18e-359f-4018-b958-31bb4adf310f";

  console.log(`\n🔍 Fetching workflow by ID: ${wfId}...`);

  const { data: wf, error: wfErr } = await supabase
    .from("workflow")
    .select("*")
    .eq("id", wfId)
    .single();

  if (wfErr) {
    console.error("❌ Workflow fetch error:", wfErr);
  } else {
    console.log("📌 Workflow found in DB:");
    console.log(wf);
  }
}

checkWorkflowById().catch(console.error);
