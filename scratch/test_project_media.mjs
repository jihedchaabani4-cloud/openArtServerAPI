import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testQuery() {
  const projectId = "f92a8c2a-be6a-4a52-9ca2-56ee8dd107a9";
  console.log("🔍 Testing media query for project:", projectId);

  const { data: mediaItems, error: mediaError } = await supabase
    .from("media")
    .select(`
        id, step_id, url, width, height, create_time, status, error_message,
        workflow_id, generation_config_id,
        generation_config (
            id, prompt, model, aspect_ratio, generation_type, seed, visibility,
            dna:dna ( id, name, type, description, traits ),
            references:generation_config_reference!generation_config_reference_generation_config_id_fkey (
                id, position, input_type, ref_media_id,
                ref_media:media ( id, url, width, height )
            )
        )
    `)
    .eq("project_id", projectId)
    .order("create_time", { ascending: false });

  if (mediaError) {
    console.error("❌ Media query error:", mediaError);
  } else {
    console.log(`✅ Media items found: ${mediaItems?.length}`);
    if (mediaItems?.length > 0) {
      console.log("First media item:", JSON.stringify(mediaItems[0], null, 2));
    }
  }

  // Also query media table directly without join
  const { data: rawMedia } = await supabase
    .from("media")
    .select("*")
    .eq("project_id", projectId);

  console.log(`\n📊 Raw media rows directly in DB for project: ${rawMedia?.length}`);
  if (rawMedia?.length > 0) {
    console.log("Raw media sample:", rawMedia.slice(0, 3));
  }

  process.exit(0);
}

testQuery().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
