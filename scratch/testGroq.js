import "dotenv/config";
import { GroqProvider } from "../src/core/providers/GroqProvider.js";
import { PromptService } from "../src/services/PromptService.js";

async function test() {
  const apiKey = process.env.GROQ_API_KEY;
  const groq = new GroqProvider(apiKey);
  const promptService = new PromptService(groq);

  const testPrompts = [
    "cat in paris", // english simple
    "قطوسة مزيانة في باريس تظحك", // tunisian simple (beautiful laughing female cat in paris)
    "taswira ta3 tfol sghir l2abes fatet mte3 9raya w yal3ab b chkarta fidou", // tunisian darija complex (photo of a young kid wearing school uniform and playing with a bag in his hand)
  ];

  for (const p of testPrompts) {
    console.log(`\n==================================================`);
    console.log(`Original Input: "${p}"`);
    try {
      const res = await promptService.optimizePrompt(p, { mode: "image" });
      console.log("Result object:", JSON.stringify(res, null, 2));
    } catch (e) {
      console.error("Failed:", e.message);
    }
  }
}

test();
