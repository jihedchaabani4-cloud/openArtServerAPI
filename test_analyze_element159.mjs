import { ElementVisionService } from "../my-app/src/features/workflows/services/ElementVisionService.js";
import { supabase } from "./lib/supabase.js";

async function testElement159() {
  const workflowId = "238615f5-fd97-41b0-ab82-0e2df04490cb";

  // Find project_id for this workflow
  const { data: wf } = await supabase
    .from("workflow")
    .select("project_id")
    .eq("id", workflowId)
    .single();

  const projectId = wf.project_id;
  console.log(`🚀 Triggering Vision Analysis for element159 (projectId: ${projectId}, workflowId: ${workflowId})...`);

  const result = await ElementVisionService.analyzeElement({
    projectId,
    workflowId,
    headers: {
      "x-internal-secret": "openart_internal_s2s_secret_2026",
    },
  });

  console.log("\n✅ Vision Analysis Result:");
  console.dir(result, { depth: null });

  // Query database directly to confirm save
  const { data: elemRecord } = await supabase
    .from("element")
    .select("description, keywords, guidelines")
    .eq("workflow_id", workflowId)
    .single();

  console.log("\n💾 DB Verification Result for element159 in Supabase:");
  console.dir(elemRecord, { depth: null });
}

testElement159().catch(console.error);
