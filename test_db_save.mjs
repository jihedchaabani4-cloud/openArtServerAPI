import { ElementRepository } from "./src/db/ElementRepository.js";

async function testDBSave() {
  const repo = new ElementRepository();
  const testWorkflowName = "element159";
  console.log("🔍 Testing database save using display_name 'element159':");

  try {
    const res = await repo.update(testWorkflowName, {
      description: "Updated description for element159 " + Date.now(),
      keywords: ["dreamcore", "liminal", "surreal", "pastel"],
      guidelines: "Always keep pastel colors and soft lighting.",
    });

    console.log("✅ Update result returned from ElementRepository:");
    console.dir(res, { depth: null });
  } catch (err) {
    console.error("❌ DB Update Error:", err);
  }
}

testDBSave().catch(console.error);
