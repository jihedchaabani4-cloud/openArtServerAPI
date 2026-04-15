import fetch from "node-fetch"; // or built-in if Node >= 18
import { BaseModel } from "#core/BaseModel.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const POLL_INTERVAL  = 3000;
const POLL_TIMEOUT   = 300_000;

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

    async _submit(payload) {
        const response = await fetch(`${REPLICATE_BASE}/models/${this.modelName}/predictions`, {
            method:  "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${this.apiKey}`,
                "Prefer":        "wait",
            },
            body: JSON.stringify({ input: payload }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Replicate submit failed [${response.status}]: ${err}`);
        }

        const data = await response.json();
        return { id: data.id, urls: data.urls };
    }

    async _poll(id, getUrl) {
        const url     = getUrl || `${REPLICATE_BASE}/predictions/${id}`;
        const deadline = Date.now() + POLL_TIMEOUT;

        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));

            const res  = await fetch(url, { headers: { "Authorization": `Bearer ${this.apiKey}` } });
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
        throw new Error(`Replicate timed out after ${POLL_TIMEOUT / 1000}s`);
    }

    async generate(payload, mode) {
        const { id, urls } = await this._submit(payload);
        return this._poll(id, urls?.get);
    }
}
