import "dotenv/config";
import "../src/workflows/registerWorkflows.js";
import { workflowRunner } from "../src/container.js";
import { supabase } from "../lib/supabase.js";

async function test() {
  console.log("=== Testing WorkflowRunner Placeholders ===");

  const userId = "7d40bff4-7cac-4f2d-8994-2642c90e40e4";
  
  // 1. Get a test project owned by this user
  const { data: project } = await supabase
    .from("project")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .single();

  if (!project) {
    console.error("No project found for user!");
    return;
  }

  console.log("Using Project ID:", project.id);

  // 2. Call workflowRunner.run directly with a prompt that WILL succeed safety but fail generation
  try {
    const result = await workflowRunner.run({
      workflowId: "first-slice-image-generation",
      caller: {
        type: "internal",
        userId: userId,
      },
      input: {
        prompt: "a cat in Paris",
        model_name: "nanobana_pro",
        project_id: project.id,
      }
    });

    console.log("Workflow Result Status:", result.status);

    // 3. Query the DB to check if a failed media record was saved!
    console.log("\n=== Checking DB for latest media record ===");
    const { data: media } = await supabase
      .from("media")
      .select("id, status, error_message, project_id, create_time")
      .eq("project_id", project.id)
      .order("create_time", { ascending: false })
      .limit(1);

    console.log("Latest Media Record in DB:", JSON.stringify(media, null, 2));
  } catch (err) {
    console.error("Test execution failed:", err);
  }
}

test();
