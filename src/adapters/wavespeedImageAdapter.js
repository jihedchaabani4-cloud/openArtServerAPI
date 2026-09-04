import { ProviderMalformedResponseError } from "../models/errors/index.js";

const RESOLUTION_ASPECT_MAP = {
  "1k": {
    "1:1": "1024x1024",
    "16:9": "1024x576",
    "9:16": "576x1024",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "3:2": "1080x720",
    "2:3": "720x1080",
    "21:9": "1260x540",
  },
  "2k": {
    "1:1": "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "3:2": "2160x1440",
    "2:3": "1440x2160",
    "21:9": "2560x1080",
  },
  "4k": {
    "1:1": "4096x4096",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "4:3": "4096x3072",
    "3:4": "3072x4096",
    "3:2": "4320x2880",
    "2:3": "2880x4320",
    "21:9": "5120x2160",
  },
};

export class WaveSpeedImageAdapter {
  /**
   * Translates validated canonical inputs into provider request payload.
   * @param {Record<string, any>} cleanInput
   * @param {object} deploymentConfig
   */
  toProviderPayload(cleanInput = {}, deploymentConfig = {}) {
    const fieldMapping = deploymentConfig.fieldMapping || {};
    const body = {};

    for (const [key, val] of Object.entries(cleanInput)) {
      const targetKey = fieldMapping[key] || key;
      body[targetKey] = val;
    }

    // Map resolution + aspect_ratio to WaveSpeed size
    const resolution = cleanInput.resolution || "1k";
    const aspectRatio = cleanInput.aspect_ratio || "1:1";
    if (RESOLUTION_ASPECT_MAP[resolution] && RESOLUTION_ASPECT_MAP[resolution][aspectRatio]) {
      body.size = RESOLUTION_ASPECT_MAP[resolution][aspectRatio];
    } else if (cleanInput.resolution && cleanInput.aspect_ratio) {
      body.size = `${cleanInput.resolution}_${cleanInput.aspect_ratio}`;
    }

    // Normalize quality for WaveSpeed API requirements
    if (cleanInput.quality || body.quality) {
      const q = String(cleanInput.quality || body.quality).toLowerCase();
      if (q === "standard") {
        body.quality = "medium";
      } else if (q === "hd") {
        body.quality = "high";
      } else if (q === "2k") {
        body.quality = "medium";
      } else if (q === "4k") {
        body.quality = "high";
      } else if (["low", "medium", "high"].includes(q)) {
        body.quality = q;
      } else {
        body.quality = "medium";
      }
    }

    const endpoint =
      deploymentConfig.endpoint ||
      "https://api.wavespeed.ai/v1/images/generations";

    return {
      endpoint,
      method: "POST",
      body,
      // Retain root attributes for callers that consume flat payload
      ...body,
    };
  }

  /**
   * Normalizes provider HTTP response into platform StandardOutput format.
   * @param {any} providerResponse
   * @param {object} deploymentConfig
   */
  fromProviderResponse(providerResponse = {}, deploymentConfig = {}) {
    if (!providerResponse || typeof providerResponse !== "object") {
      throw new ProviderMalformedResponseError("WaveSpeed response is not an object");
    }

    const outputDef = deploymentConfig.outputs || deploymentConfig;
    const outputType = outputDef.type || "image";

    const url =
      (Array.isArray(providerResponse.outputs) && providerResponse.outputs[0]) ||
      providerResponse.output?.url ||
      providerResponse.url ||
      providerResponse.image_url;

    if (outputDef.fields?.url?.required && !url) {
      throw new ProviderMalformedResponseError("WaveSpeed response missing required output field: 'url'");
    }

    return {
      type: outputType,
      url: url || null,
      metadata: providerResponse.metadata || {},
    };
  }
}

export const wavespeedImageAdapter = new WaveSpeedImageAdapter();
export default wavespeedImageAdapter;
