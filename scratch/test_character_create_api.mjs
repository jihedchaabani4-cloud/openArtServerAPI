import "dotenv/config";
import { createCharacter } from "../controllers/characterController.js";
import { registerAllManifests } from "../src/v2/nodes/manifests/registerManifests.js";

async function testCharacterCreateAPI() {
  console.log("\n=======================================================");
  console.log("🚀 TESTING CLEAN CHARACTER CREATION API (/api/characters/create)");
  console.log("=======================================================\n");

  registerAllManifests();

  const req = {
    user: { id: process.env.INTERNAL_USER_ID || "7d40bff4-7cac-4f2d-8994-2642c90e40e4" },
    body: {
      project_id: "40f3810f-960c-4d2b-b1e1-6e6684ed936d",
      prompt: "محارب روبوتي نيون بشعر أبيض وقناع شفاف",
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

  console.log("[Test API] Calling createCharacter API controller...");
  console.log("   - User ID:", req.user.id);
  console.log("   - Project ID:", req.body.project_id);
  console.log("   - Prompt:", req.body.prompt);

  await createCharacter(req, res);

  console.log("\n=== API Response Received ===");
  console.log(`Status Code: ${statusCode}`);
  console.log("Response Body:\n", JSON.stringify(resData, null, 2));

  if (statusCode !== 200 || !resData || resData.ok === false) {
    throw new Error("API Test Failed: Controller returned non-200 or failure status.");
  }

  console.log("\n=======================================================");
  console.log("🎉 CLEAN CHARACTER CREATION API TEST PASSED SUCCESSFULLY!");
  console.log("=======================================================\n");
}

testCharacterCreateAPI().catch((err) => {
  console.error("\n❌ API TEST FAILED:", err);
  process.exit(1);
});
