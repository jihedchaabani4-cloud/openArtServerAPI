import { BaseModel } from "#core/BaseModel.js";
import fetch from "node-fetch";

export class SdxlImageRunner extends BaseModel {
    constructor(config) {
        super(config);
        this.baseUrls = Array.isArray(config.baseUrl) ? config.baseUrl : [config.baseUrl];
    }

    async _fetchWithFallback(endpoint, payload) {
        let lastError = null;

        for (const url of this.baseUrls) {
            try {
                console.log(`🔌 [SDXL Ngrok] Trying endpoint: ${url}${endpoint}`);
                const response = await fetch(`${url}${endpoint}`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'ngrok-skip-browser-warning': 'true',
                        'User-Agent': 'OpenArt-AI-Studio'
                    },
                    body: JSON.stringify(payload),
                    timeout: 120000 
                });

                const text = await response.text();
                if (text.includes("ERR_NGROK_") || text.includes("tunnel is offline") || !response.ok) {
                    throw new Error(text || `HTTP ${response.status}`);
                }

                try {
                    return JSON.parse(text);
                } catch (e) {
                    throw new Error("Invalid JSON response from server");
                }
            } catch (err) {
                console.warn(`⚠️ [SDXL Ngrok] Endpoint ${url} failed: ${err.message.substring(0, 100)}...`);
                lastError = err;
            }
        }
        throw new Error(`All SDXL Ngrok endpoints are offline. Last error: ${lastError?.message}`);
    }

    _calculateDimensions(ratio, quality) {
        const ratios = {
            "1:1":  [1024, 1024],
            "16:9": [1024, 576],
            "9:16": [768, 1360], 
            "4:3":  [1024, 768],
            "3:4":  [768, 1024],
            "3:2":  [1024, 680],
            "2:3":  [680, 1024],
            "21:9": [1024, 440]
        };
        const [w, h] = ratios[ratio] || [768, 1024];
        return { w, h };
    }

    async generate(payload) {
        console.log(`🚀 [SDXL Ngrok] Generating: ${payload.prompt}`);
        const result = await this._fetchWithFallback("/generate", payload);
        return {
            image_base64: result.image_base64,
            seed: result.seed,
            time_seconds: result.time_seconds
        };
    }

    async generateMultiRef(payload) {
        console.log(`🚀 [SDXL Ngrok] Multi-Ref Img2Img`);
        const result = await this._fetchWithFallback("/generate_multi_ref", payload);
        const items = (result.shots || []).map(s => ({
            image_base64: s.image_base64,
            seed: s.seed,
            prompt: s.prompt
        }));
        return {
            items,
            time_seconds: result.time_seconds
        };
    }
}
