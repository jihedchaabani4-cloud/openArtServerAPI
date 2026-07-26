import "dotenv/config";
import { supabase } from "../lib/supabase.js";

async function fixMediaStatus() {
    console.log("Fixing media status for elements...");
    const { data, error } = await supabase
        .from("media")
        .update({ status: "completed" })
        .eq("step_id", "CAE")
        .not("url", "is", null)
        .select();

    if (error) {
        console.error("Failed to update media status:", error);
    } else {
        console.log(`Updated ${data?.length || 0} element media records to status: completed!`);
    }
}

fixMediaStatus();
