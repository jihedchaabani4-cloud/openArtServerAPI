import { executePromptBuilder } from "./src/v2/nodes/promptBuilderNode.js";

async function runTest() {
  console.log("--- Testing promptBuilderNode Pure Context Resolution ---");

  const inputs = {
    prompt: "A cinematic scene with @Sarah holding <element:elem_1> in a luxury bathroom",
    characters: [
      { id: "char_100", name: "Sarah", visualTraits: ["young woman", "brown hair"], createdAt: "2026-01-01", ownerId: "usr_99" }
    ],
    references: [
      { id: "ref_1", url: "https://example.com/ref1.png", role: "style_reference" }
    ]
  };

  const ctx = {
    runId: "run-test-1",
    nodeId: "pb-node-1",
    userId: "usr-1"
  };

  const result = await executePromptBuilder(inputs, ctx);

  console.log("✅ Fast Prompt Fallback:", result.finalPrompt);
  console.log("✅ Context Snapshot:", JSON.stringify(result.context, null, 2));

  // Assertions
  if (!result.finalPrompt) throw new Error("finalPrompt is empty!");
  if (!result.context.entities) throw new Error("context.entities missing!");
  if (result.context.entities.characters[0].createdAt) throw new Error("DB metadata was not filtered!");

  console.log("\n🎉 ALL PROMPT BUILDER TESTS PASSED CLEANLY!");
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
