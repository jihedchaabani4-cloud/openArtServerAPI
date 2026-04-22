import fetch from "node-fetch"; // or built-in if Node >= 18
import { BaseModel } from "#core/BaseModel.js";
import { resolveExecutionPolicy } from "#core/execution/ExecutionPolicy.js";
import { createTimeoutSignal, sleep } from "#core/execution/ExecutionHelpers.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";

/**
 * Base class for Replicate video runners.
 * Compatible interface with WavespeedVideoRunner so it can be
 * swapped in MODEL_ROUTES transparently.
 */
export class ReplicateVideoRunner extends BaseModel {
    constructor(options) {
        super(options);
        this.apiKey = process.env.REPLICATE_API_KEY;
    }

    async _submit(payload, policy) {
        const response = await fetch(`${REPLICATE_BASE}/models/${this.modelName}/predictions`, {
            method:  "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${this.apiKey}`,
                "Prefer":        "wait",
            },
            body: JSON.stringify({ input: payload }),
            signal: createTimeoutSignal(policy.requestTimeoutMs),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Replicate submit failed [${response.status}]: ${err}`);
        }

        const data = await response.json();
        return { id: data.id, urls: data.urls };
    }

    async _poll(id, getUrl, policy) {
        const url     = getUrl || `${REPLICATE_BASE}/predictions/${id}`;
        const deadline = Date.now() + policy.maxDurationMs;

        while (Date.now() < deadline) {
            await sleep(policy.pollIntervalMs);

            const res  = await fetch(url, {
                headers: { "Authorization": `Bearer ${this.apiKey}` },
                signal: createTimeoutSignal(policy.pollTimeoutMs),
            });
            if (!res.ok) continue;

            const data   = await res.json();
            const status = data.status;

            if (status === "succeeded") {
                const output = Array.isArray(data.output) ? data.output[0] : data.output;
                return { video_url: output || null, image_url: null };
            }
            if (status === "failed" || status === "canceled") {
                throw new Error(`Replicate prediction ${status}: ${data.error || "unknown"}`);
            }
        }
        throw new Error(`Replicate timed out after ${policy.maxDurationMs / 1000}s`);
    }

    async generate(payload, mode) {
        const policy = resolveExecutionPolicy(payload, {
            type: "video",
            provider: this.provider,
            model: this.modelName,
        });
        const { id, urls } = await this._submit(payload, policy);
        return this._poll(id, urls?.get, policy);
    }
}
