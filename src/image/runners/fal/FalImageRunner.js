import { BaseModel } from "#core/BaseModel.js";
import { resolveExecutionPolicy } from "#core/execution/ExecutionPolicy.js";
import { createTimeoutSignal } from "#core/execution/ExecutionHelpers.js";
import fetch from "node-fetch";

export class FalImageRunner extends BaseModel {
    constructor(config) {
        super(config);
        this.apiKey = process.env.FAL_API_KEY || "none";
        this.baseUrl = "https://fal.run";
    }

    async _urlToBase64(url) {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    }

    async generate(payload) {
        console.log(`🚀 [Fal.ai] Generating image with model: ${this.modelName}`);
        const policy = resolveExecutionPolicy(payload, {
            type: "image",
            provider: this.provider,
            model: this.modelName,
        });

        const response = await fetch(`${this.baseUrl}/${this.modelName}`, {
            method: "POST",
            headers: {
                "Authorization": `Key ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            signal: createTimeoutSignal(policy.requestTimeoutMs),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Fal.ai API Error: ${err}`);
        }

        const result = await response.json();
        const imageUrl = result.images[0].url;
        const image_base64 = await this._urlToBase64(imageUrl);

        return {
            image_base64,
            seed: result.seed || null,
            time_seconds: result.timings?.inference || 0
        };
    }
}
