import { GoogleGenerativeAI } from "@google/generative-ai";
import { BaseTextProvider } from "./BaseTextProvider.js";

export class GeminiTextProvider extends BaseTextProvider {
    constructor(apiKey, model = "gemini-1.5-pro") {
        super();
        this.apiKey = apiKey;
        this.model = model;
    }

    async complete({ systemPrompt, userPrompt, temperature = 0.7, jsonMode = false }) {
        const genAI = new GoogleGenerativeAI(this.apiKey);
        
        // Configure options with system instruction and JSON mode if requested
        const options = {
            model: this.model,
            systemInstruction: systemPrompt,
        };

        if (jsonMode) {
            options.generationConfig = {
                responseMimeType: "application/json",
                temperature
            };
        } else {
            options.generationConfig = {
                temperature
            };
        }

        const genModel = genAI.getGenerativeModel(options);
        const result = await genModel.generateContent(userPrompt);
        return result.response.text();
    }

    async completeJSON(params) {
        const text = await this.complete({ ...params, jsonMode: true });
        try {
            // Strip any markdown code block wrappers if returned by the LLM
            const jsonMatch = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
            return JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch (e) {
            console.error("❌ [GeminiTextProvider] JSON Parse Error:", e.message, "Raw:", text);
            throw e;
        }
    }
}
