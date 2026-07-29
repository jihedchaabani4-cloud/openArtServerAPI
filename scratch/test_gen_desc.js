import "dotenv/config";
import { llmService } from "../src/services/LLMService.js";

const CHARACTER_GENERATOR_SYSTEM_PROMPT = `
You are an elite haute-couture AI Art Director and Master Character Designer for high-budget cinematic films and editorial fashion houses.
Your task: Given a character concept, archetype, or brief description (such as "The Eccentric", "The Botanical Visionary", "The Wicked", or a custom user prompt), generate an ultra-rich, highly descriptive, editorial character description.

Focus heavily on:
1. Facial geometry, anatomical features, skin texture, and unique biological/sub-dermal details.
2. Architectural hair/headpiece design and editorial posture.
3. Outfit materials, structural tailoring, fabrics (waxy leaves, felted wool, translucent fibers, wet-look surfaces).
4. Cinematic lighting, color mood, and authoritative visual presence.

CRITICAL OUTPUT REQUIREMENT:
You MUST return your response as a valid JSON object with this schema:
{
  "title": "A short 2-4 word evocative character name/title",
  "description": "A 3-5 sentence ultra-detailed, editorial character description ready for high-end AI generation.",
  "keywords": ["5-10 concise factual visual identity keywords"]
}
Do NOT include any markdown code blocks or extra text outside the JSON object.
`;

async function main() {
  console.log("🚀 Testing Character Description AI Generation...");
  const result = await llmService.generate({
    prompt: 'Generate a masterwork character description for the concept: "L\'excentrique"',
    systemInstruction: CHARACTER_GENERATOR_SYSTEM_PROMPT,
    jsonMode: true,
  });

  console.log("\n✅ Test Execution Result:");
  console.log("Model Used:", result.model);
  console.log("Parsed JSON Output:", JSON.stringify(result.json || result.raw, null, 2));
}

main().catch(console.error);
