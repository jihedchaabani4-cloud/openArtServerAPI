import { BaseModel } from "#core/BaseModel.js";

const WAVESPEED_BASE = "https://api.wavespeed.ai/api/v3";
const POLL_INTERVAL  = 3000;
const POLL_TIMEOUT   = 300000;

export class WavespeedVideoRunner extends BaseModel {
    constructor(options) {
        super(options);
        this.apiKey = process.env.WAVESPEED_API_KEY;
    }

    async _submit(payload) {
        const response = await fetch(
            `${WAVESPEED_BASE}/${this.modelName}`,
            {
                method:  "POST",
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(payload),
            }
        );
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Wavespeed submit failed [${response.status}]: ${err}`);
        }
        const data = await response.json();
        return data.data?.id || data.id;
    }

// ✅ الصحيح
    async _poll(taskId, pollUrl) {
        const deadline = Date.now() + POLL_TIMEOUT;
        // Uses pollUrl if provided, otherwise constructs it from taskId
        const url = pollUrl || `${WAVESPEED_BASE}/predictions/${taskId}/result`;

        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));

            const response = await fetch(url, {
                headers: { "Authorization": `Bearer ${this.apiKey}` },
            });

            if (!response.ok) continue;

            const data   = await response.json();
            const res    = data.data || data;
            const status = res.status;

            if (status === "completed" || status === "succeeded") {
                const outputs = res.outputs || [];
                return { video_url: outputs[0] || null, image_url: null };
            }

            if (status === "failed") {
                throw new Error(`Wavespeed task failed: ${res.error || "Unknown error"}`);
            }
        }
        throw new Error(`Wavespeed task timed out after ${POLL_TIMEOUT / 1000}s`);
    }

    // ── Methods ──────────────────────────────────────────────────────────────
    async imageToVideo(payload)  { return this._poll(await this._submit(payload)); }
    async textToVideo(payload)   { return this._poll(await this._submit(payload)); }
    async motionControl(payload) { return this._poll(await this._submit(payload)); }

    async generate(payload) {
        if (this.type === "t2v")                       return this.textToVideo(payload);
        if (this.type === "i2v" || this.type === "r2v" || this.type === "v2v") return this.imageToVideo(payload);
        if (this.type === "motion")                     return this.motionControl(payload);
        throw new Error(`Wavespeed runner does not support type: ${this.type}`);
    }
}
