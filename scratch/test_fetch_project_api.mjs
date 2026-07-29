import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function testFetchProjectData() {
  const projectId = "12c38e64-69b1-430d-b313-02a4c4f29b18";

  console.log(`\n🔍 Fetching project data for Project ID: ${projectId}...`);

  const { data: workflows } = await supabase
    .from("workflow")
    .select("id, display_name, workflow_type, create_time, primary_media_id")
    .eq("project_id", projectId);

  const { data: media } = await supabase
    .from("media")
    .select("id, workflow_id, url, status, create_time")
    .eq("project_id", projectId);

  console.log(`\n📌 Workflows found: ${workflows?.length || 0}`);
  console.log(workflows);

  console.log(`\n📌 Media items found: ${media?.length || 0}`);
  console.log(media);

  // Filter characters using the exact logic from useCharacterWorkflows in frontend
  const characters = (workflows || [])
    .filter((w) => {
      const wType = String(w.workflow_type || "").toUpperCase();
      return wType === "CHARACTER" || wType === "CHARACTER_SHEET" || wType === "ELEMENT_SHEET";
    })
    .map((w) => {
      const items = (media || []).filter((m) => m.workflow_id === w.id);
      return { ...w, items };
    });

  console.log(`\n🎉 Characters matched for Frontend: ${characters.length}`);
  console.log(JSON.stringify(characters, null, 2));
}

testFetchProjectData().catch(console.error);
