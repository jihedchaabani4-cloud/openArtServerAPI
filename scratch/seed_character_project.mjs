import "dotenv/config";
import { createCharacter } from "../controllers/characterController.js";
import { registerAllManifests } from "../src/v2/nodes/manifests/registerManifests.js";

async function seedCharacterForUserProject() {
  const projectId = "40f3810f-960c-4d2b-b1e1-6e6684ed936d";

  console.log(`\n🚀 Seeding character workflow for user's active Project ID: ${projectId}...`);

  registerAllManifests();

  const req = {
    user: { id: process.env.INTERNAL_USER_ID || "7d40bff4-7cac-4f2d-8994-2642c90e40e4" },
    body: {
      project_id: projectId,
      prompt: "محارب روبوتي نيون بشعر أبيض وقناع شفاف - Cyberpunk Ronin Character Sheet",
      style: "cinematic",
      references: [],
    },
  };

  let resData = null;
  let statusCode = 200;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      resData = payload;
      return this;
    },
  };

  await createCharacter(req, res);

  console.log("\n=== Character Workflow Seeded Successfully ===");
  console.log(`Status Code: ${statusCode}`);
  console.log("Response Body:\n", JSON.stringify(resData, null, 2));
}

seedCharacterForUserProject().catch(console.error);
