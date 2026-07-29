import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function cleanElementTableForCharacters() {
  console.log("\n🧹 Removing character records from 'element' table...");

  const { data, error } = await supabase
    .from("element")
    .delete()
    .eq("element_type", "character");

  if (error) {
    console.error("❌ Error cleaning element table:", error);
  } else {
    console.log("✅ Successfully cleaned 'element' table! Characters now live ONLY in their dedicated domain tables.");
  }
}

cleanElementTableForCharacters().catch(console.error);
