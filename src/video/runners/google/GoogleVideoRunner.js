import { BaseModel } from "#core/BaseModel.js";
import fetch from "node-fetch";

const GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export class GoogleVideoRunner extends BaseModel {
    constructor(options) {
        super(options);
        this.apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY || "none";
    }

    async _submit(payload) {
        console.log(`🚀 [Google Video] Generating video with model: ${this.modelName}`);
        
        const url = `${GOOGLE_API_URL}/${this.modelName}:predict?key=${this.apiKey}`;
        
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                instances: [
                    { prompt: payload.prompt }
                ],
                parameters: {
                    sampleCount: 1,
                    aspectRatio: payload.aspect_ratio || "16:9",
                    duration: payload.duration || 5
                }
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Google Video API Error: ${err}`);
        }

        const data = await response.json();
        // Assuming Veo returns a taskId or the video directly. 
        // For now, assume it's like Imagen and returns bytes/URL.
        return data.predictions?.[0];
    }

    async generate(payload) {
        const result = await this._submit(payload);
        if (result?.bytesBase64Encoded) {
            // Convert to URL or just return as is
            return { video_url: null, video_base64: result.bytesBase64Encoded };
        }
        return { video_url: result?.url || null, image_url: null };
    }
}
