import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function run() {
  const { data, error } = await supabase
    .from("project")
    .select("id, user_id")
    .eq("id", "7840df10-9cce-43c4-85a0-6b885ca5f1e1")
    .single();

  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Project:", data);
  }
}

run();
