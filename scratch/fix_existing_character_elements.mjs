import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function fixExistingCharacterElements() {
  const ids = ["2aca06a0-a45b-4543-a0ed-31a62bd8733a", "06297fb0-ab9d-41ab-8748-72a7c17b46cb"];

  console.log("\n🛠️ Upserting element records with element_type = 'character'...");

  for (const id of ids) {
    const { data: wf } = await supabase.from("workflow").select("*").eq("id", id).single();
    if (!wf) continue;

    const { error } = await supabase.from("element").upsert({
      id: wf.id,
      workflow_id: wf.id,
      name: wf.display_name ? wf.display_name.slice(0, 40) : "Character",
      element_type: "character",
      description: wf.display_name || "",
    });

    if (error) console.error(`❌ Error updating ${id}:`, error.message);
    else console.log(`✅ Character element tagged for workflow ${id}`);
  }
}

fixExistingCharacterElements().catch(console.error);
