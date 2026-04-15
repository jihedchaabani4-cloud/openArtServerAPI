import OpenAI from "openai";
import { BaseTextProvider } from "./BaseTextProvider.js";

export class OpenAITextProvider extends BaseTextProvider {
    constructor(apiKey, model = "gpt-4o-mini") {
        super();
        this.client = new OpenAI({ apiKey });
        this.model = model;
    }

    async complete({ systemPrompt, userPrompt, temperature = 0.7 }) {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature
        });
        return response.choices[0].message.content;
    }

    async completeJSON({ systemPrompt, userPrompt, temperature = 0.7 }) {
        const text = await this.complete({ systemPrompt, userPrompt, temperature });
        try {
            const jsonMatch = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
            return JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch (e) {
            console.error("❌ [OpenAITextProvider] JSON Parse Error:", e.message, "Raw:", text);
            throw e;
        }
    }
}
