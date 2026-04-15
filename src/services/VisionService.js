// src/services/VisionService.js
export class VisionService {
    /**
     * @param {import('../core/providers/GroqProvider').GroqProvider} groqProvider
     */
    constructor(groqProvider) {
        this.groqProvider = groqProvider;
    }

    /**
     * Analyzes an image and returns a description or answers questions about it
     * @param {Object} params
     * @param {string} params.image - Base64 string or public URL
     * @param {string} [params.prompt]
     */
    async analyze(params) {
        const { image, prompt } = params;

        if (!image) {
            throw new Error("Image (base64 or URL) is required for analysis.");
        }

        try {
            console.log(`👁️ [VisionService] Analyzing image...`);
            const analysis = await this.groqProvider.analyzeImage({
                prompt: prompt || "Analyze this image and provide a detailed description. Focus on objects, mood, lighting, and cinematic quality.",
                image
            });

            console.log(`🔍 [VisionService] Image Analysis Result:`, analysis);

            return {
                analysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error("❌ [VisionService] Error:", error);
            throw error;
        }
    }

    /**
     * Specifically extracts prompts or styles from an image to reuse them
     * @param {string} image - Base64 string or public URL
     */
    async extractPrompt(image) {
        const prompt = "Describe this image in a single paragraph as a prompt for an AI image generator. Include details about lighting, camera angle, and style.";
        const result = await this.analyze({ image, prompt });
        return result.analysis;
    }

    /**
     * Generates 3-5 "What's Next" prompts based on an image
     * @param {string} image - Base64 string or public URL
     */
    async generateWhatsNextPrompts(image) {
        try {
            console.log(`🧠 [VisionService] Generating "What's Next" ideas...`);
            
            // Step 1: Analyze the image
            const analysis = await this.analyze({ 
                image, 
                prompt: "Analyze this image and list the main subjects, setting, and mood." 
            });

            // Step 2: Use Groq to generate creative next steps
            const systemPrompt = `You are an elite creative director for a high-end cinematic AI studio.
Based on the analysis of an image, suggest 3-5 creative "What's Next" scenarios.
Each scenario MUST be a hyper-detailed, technical, and cinematic prompt for an AI image generator (like Midjourney or SDXL).

Guidelines for each prompt:
- Style: Ultra-realistic, cinematic, high-fidelity.
- Details: Include specific lighting (e.g., golden hour, rim lighting, volumetric fog), camera gear (e.g., shot on ARRI Alexa Mini LF, 85mm lens, f/1.8), and technical specs (e.g., hyper-detailed skin texture, 8k resolution, ray-traced shadows).
- Consistency: Keep the main subject consistent with the original analysis but change the setting, action, or mood.
- Format: Return the result as a JSON array of strings only. No extra talk.

Example:
["Ultra-realistic cinematic portrait of the character in a neon-lit cyberpunk rain, hyper-detailed skin, shot on 35mm lens, f/2.8, volumetric lighting, 8k", "Cinematic wide shot of the character walking through a mystical ancient forest, golden hour lighting, deep bokeh, highly detailed environment, 8k"]`;

            const userPrompt = `Original Image Analysis: ${analysis.analysis}. 
Generate 3-5 high-end cinematic "What's Next" prompts based on this character/subject.`;

            const suggestionsRaw = await this.groqProvider.complete({
                systemPrompt,
                userPrompt,
                jsonMode: false // Changed to false for better debugging of raw output
            });

            console.log(`📝 [VisionService] Raw suggestions:`, suggestionsRaw);

            let prompts = [];
            try {
                // Try to extract JSON from the string if it contains markdown or extra text
                const jsonMatch = suggestionsRaw.match(/\[[\s\S]*\]/);
                const jsonStr = jsonMatch ? jsonMatch[0] : suggestionsRaw;
                const parsed = JSON.parse(jsonStr);
                prompts = Array.isArray(parsed) ? parsed : (parsed.prompts || parsed.suggestions || []);
            } catch (e) {
                console.warn(`⚠️ [VisionService] JSON parse failed, falling back to line split.`, e.message);
                prompts = suggestionsRaw.split("\n")
                    .map(l => l.replace(/^\d+\.\s*/, "").replace(/^- \s*/, "").replace(/"/g, "").trim())
                    .filter(l => l.length > 10)
                    .slice(0, 5);
            }

            return {
                analysis: analysis.analysis,
                prompts: prompts.slice(0, 5)
            };
        } catch (error) {
            console.error("❌ [VisionService] WhatsNext Error:", error);
            throw error;
        }
    }
}
