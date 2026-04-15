import "dotenv/config";
import { geminiModel } from "../apps/models/index.js";

/**
 * refinePromptWithGemini - Uses Gemini to refine the FLUX prompt based on user command and DNA
 */
export async function refinePromptWithGemini(userCommand, dna) {
    try {
        const prompt = `
            You are an expert AI prompt engineer for FLUX.1 image generation.
            Your task is to refine a base image generation prompt based on a user's edit command.
            
            Current DNA state (JSON):
            ${JSON.stringify(dna, null, 2)}
            
            User Edit Command: "${userCommand}"
            
            Instructions:
            1. Analyze the current DNA and the user's command.
            2. Generate a highly detailed, professional FLUX prompt (150-200 words).
            3. Maintain the character's identity (features from identity_dna).
            4. Focus the changes on the areas specified in the user command.
            5. Return ONLY the refined prompt text. No explanations.
        `;

        return await geminiModel.run(prompt);
    } catch (error) {
        console.error("Gemini refinement failed:", error);
        // Fallback to a simple string if Gemini fails
        return `A professional portrait based on: ${userCommand}`;
    }
}
