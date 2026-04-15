import { BaseModel } from "#core/BaseModel.js";
import fetch from "node-fetch";

/**
 * GoogleImageRunner
 * Uses Gemini generateContent API with responseModalities: ["IMAGE", "TEXT"]
 */
export class GoogleImageRunner extends BaseModel {
    constructor(config) {
        super(config);
        this.apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || "none";
    }

    async generate(payload) {
        console.log(`🚀 [Google AI Studio] Generating image with model: ${this.modelName}`);

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`;

            const body = {
                contents: [
                    {
                        role: "user",
                        parts: [{ text: payload.prompt }]
                    }
                ],
                generationConfig: {
                    responseModalities: ["IMAGE", "TEXT"]
                }
            };

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Google AI Studio Error: ${err}`);
            }

            const result = await response.json();

            // Find the inline image part in the response
            const parts = result.candidates?.[0]?.content?.parts ?? [];
            const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith("image/"));

            if (!imagePart) {
                throw new Error("No image part found in Google AI Studio response");
            }

            return {
                image_base64: imagePart.inlineData.data,
                image_url:    null,
                seed:         null,
                time_seconds: 0
            };

        } catch (error) {
            console.error("❌ [Google AI Studio] Generation failed:", error);
            throw error;
        }
    }
}
