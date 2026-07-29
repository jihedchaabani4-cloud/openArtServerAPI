import { loadSkills } from "../src/v2/registry/skillLoader.js";

async function main() {
  console.log("[Test] Loading skills: llm/translation, llm/character-description, llm/json-output...");
  const prompt = await loadSkills(["llm/translation", "llm/character-description", "llm/json-output"]);
  
  console.log("=== Assembled System Prompt ===");
  console.log(prompt);
  console.log("===============================");
  console.log(`✅ Loaded successfully. Total length: ${prompt.length} chars.`);

  if (!prompt.includes("LANGUAGE RULE") || !prompt.includes("Art Director") || !prompt.includes("CRITICAL OUTPUT RULE")) {
    throw new Error("Validation failed: Skill instructions incomplete.");
  }
  console.log("✅ Skill validation test PASSED.");
}

main().catch(err => {
  console.error("❌ Skill validation failed:", err);
  process.exit(1);
});
