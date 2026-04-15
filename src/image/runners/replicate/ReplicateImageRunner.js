import { BaseModel } from "#core/BaseModel.js";
import fetch from "node-fetch";

export class ReplicateImageRunner extends BaseModel {
    constructor(config) {
        super(config);
        this.apiKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || "none";
        this.baseUrl = "https://api.replicate.com/v1/predictions";
    }

    async _urlToBase64(url) {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer).toString('base64');
    }

    async generate(payload) {
        console.log(`🚀 [Replicate] Generating with model: ${this.modelName}`);

        // 1. Create prediction
        const response = await fetch(this.baseUrl, {
            method: "POST",
            headers: {
                "Authorization": `Token ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                version: this.versionId,
                input: payload
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Replicate API Error: ${err}`);
        }

        let prediction = await response.json();
        const predictionId = prediction.id;

        // 2. Poll for result
        console.log(`   ⏳ [Replicate] Waiting for prediction ${predictionId}...`);
        while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const pollRes = await fetch(`${this.baseUrl}/${predictionId}`, {
                headers: { "Authorization": `Token ${this.apiKey}` }
            });
            prediction = await pollRes.json();
        }

        if (prediction.status !== "succeeded") {
            throw new Error(`Replicate generation failed: ${prediction.error || prediction.status}`);
        }

        const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
        const image_base64 = await this._urlToBase64(outputUrl);

        return {
            image_base64,
            seed: null,
            time_seconds: prediction.metrics?.predict_time || 0
        };
    }
}
