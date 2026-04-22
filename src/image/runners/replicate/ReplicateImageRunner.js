import { BaseModel } from "#core/BaseModel.js";
import { resolveExecutionPolicy } from "#core/execution/ExecutionPolicy.js";
import { createTimeoutSignal, sleep } from "#core/execution/ExecutionHelpers.js";
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
        const policy = resolveExecutionPolicy(payload, {
            type: "image",
            provider: this.provider,
            model: this.modelName,
        });

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
            }),
            signal: createTimeoutSignal(policy.requestTimeoutMs),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Replicate API Error: ${err}`);
        }

        let prediction = await response.json();
        const predictionId = prediction.id;

        // 2. Poll for result
        console.log(`   ⏳ [Replicate] Waiting for prediction ${predictionId}...`);
        const deadline = Date.now() + policy.maxDurationMs;
        while (Date.now() < deadline && prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
            await sleep(policy.pollIntervalMs);
            const pollRes = await fetch(`${this.baseUrl}/${predictionId}`, {
                headers: { "Authorization": `Token ${this.apiKey}` },
                signal: createTimeoutSignal(policy.pollTimeoutMs),
            });
            prediction = await pollRes.json();
        }

        if (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
            throw new Error(`Replicate generation timed out after ${policy.maxDurationMs}ms`);
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
