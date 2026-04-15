import OpenAI from "openai";
import { BaseTextProvider } from "./BaseTextProvider.js";

export class GroqProvider extends BaseTextProvider {
    constructor(apiKey, model = "llama-3.3-70b-versatile") {
        super();
        this.client = new OpenAI({ 
            apiKey,
            baseURL: "https://api.groq.com/openai/v1"
        });
        this.model = model;
    }

    async complete({ systemPrompt, userPrompt, temperature = 0.7, jsonMode = false }) {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature,
            response_format: jsonMode ? { type: "json_object" } : undefined
        });
        return response.choices[0].message.content;
    }

    async completeJSON(params) {
        const text = await this.complete({ ...params, jsonMode: true });
        return JSON.parse(text);
    }

    async analyzeImage({ prompt, image }) {
        const response = await this.client.chat.completions.create({
            model: "llama-3.2-11b-vision-preview",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: image.startsWith("http") ? image : `data:image/jpeg;base64,${image}` } }
                    ]
                }
            ]
        });
        return response.choices[0].message.content;
    }
}
