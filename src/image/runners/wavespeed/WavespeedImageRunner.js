import { BaseModel } from "#core/BaseModel.js";
import fetch from "node-fetch";

const BASE = "https://api.wavespeed.ai/api/v3";
const POLL_INTERVAL = 3000;
const POLL_TIMEOUT  = 600000;

export class WavespeedImageRunner extends BaseModel {
    constructor(options) {
        super(options);
        this.apiKey = process.env.WAVESPEED_API_KEY;
    }

    // ━━━ URL → Base64 ━━━
    async _urlToBase64(url) {
        if (!url) return null;
        try {
            const res = await fetch(url);
            const buf = await res.arrayBuffer();
            return Buffer.from(buf).toString("base64");
        } catch (e) {
            console.error("❌ [Wavespeed] base64 failed:", e);
            return null;
        }
    }

    // ━━━ Submit task ━━━
    async _submit(payload) {
        const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([_, v]) => v != null));

        // --- Outgoing Request Logging ---
        console.log(`\n📤 [Wavespeed] Outgoing Request:`);
        console.log(`   Model:   ${this.modelName}`);
        console.log(`   Size:    ${cleanPayload.size || "N/A"}`);
        console.log(`   Prompt:  "${cleanPayload.prompt?.substring(0, 100)}${cleanPayload.prompt?.length > 100 ? "..." : ""}"`);
        if (cleanPayload.image) console.log(`   Image:   Attached (${cleanPayload.image.substring(0, 30)}...)`);
        if (cleanPayload.images) console.log(`   Images:  ${cleanPayload.images.length} attached`);

        const res = await fetch(`${BASE}/${this.modelName}`, {
            method:  "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type":  "application/json"
            },
            body:   JSON.stringify(cleanPayload),
            signal: AbortSignal.timeout(30000)
        });

        if (!res.ok) throw new Error(`WaveSpeed submit: ${await res.text()}`);

        const json   = await res.json();
        
        // --- Task Information Logging ---
        console.log(`\n📋 [Wavespeed] Task Information Created:`);
        console.log(JSON.stringify(json, null, 2).split('\n').map(l => `   ${l}`).join('\n'));

        const taskId = json.data?.id || json.data?.task_id;
        const pollUrl = json.data?.urls?.get || null;

        if (!taskId) throw new Error(`No task_id: ${JSON.stringify(json)}`);
        return { taskId, pollUrl };
    }

    // ━━━ Cancel task ━━━
    async _cancelTask(taskId) {
        try {
            await fetch(`${BASE}/predictions/${taskId}/cancel`, {
                method:  "POST",
                headers: { "Authorization": `Bearer ${this.apiKey}` }
            });
        } catch (e) {
            console.warn(`⚠️ [Wavespeed] Cancel failed: ${e.message}`);
        }
    }

    // ━━━ Poll until done ━━━
    async _poll({ taskId, pollUrl }) {
        const start        = Date.now();
        let   attempts     = 0;
        const MAX_ATTEMPTS = Math.floor(POLL_TIMEOUT / POLL_INTERVAL);
        const url          = pollUrl || `${BASE}/predictions/${taskId}/result`;

        while (Date.now() - start < POLL_TIMEOUT && attempts < MAX_ATTEMPTS) {
            attempts++;
            await new Promise(r => setTimeout(r, POLL_INTERVAL));

            try {
                const res = await fetch(url, {
                    headers: { "Authorization": `Bearer ${this.apiKey}` },
                    signal:  AbortSignal.timeout(10000)
                });

                if (!res.ok) continue;

                const json    = await res.json();
                const data    = json.data || json;
                const status  = data.status;
                const outputs = data.outputs || [];

                if (status === "succeeded" || status === "completed") {
                    const out = outputs[0];
                    return (typeof out === "object" && out?.url) ? out.url : out || null;
                }

                if (status === "failed") {
                    throw new Error(`WaveSpeed failed: ${data.error || "unknown"}`);
                }

            } catch (err) {
                if (err.name === 'TimeoutError' || err.name === 'AbortError') continue;
                await this._cancelTask(taskId);
                throw err;
            }
        }
        await this._cancelTask(taskId);
        throw new Error(`Timeout after ${POLL_TIMEOUT}ms`);
    }

    async generate(payload) {
        const meta = await this._submit(payload);
        const url = await this._poll(meta);
        if (url) {
            const base64 = await this._urlToBase64(url);
            return { image_base64: base64, image_url: url };
        }
        return { image_base64: null, image_url: null };
    }
}
