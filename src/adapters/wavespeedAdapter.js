import { OutputContractViolationError } from "../models/errors/index.js";

export class WaveSpeedAdapter {
  toProviderPayload(cleanInput = {}, fieldMapping = {}) {
    const payload = {};
    for (const [key, val] of Object.entries(cleanInput)) {
      const targetKey = fieldMapping[key] || key;
      payload[targetKey] = val;
    }

    // Normalize quality & resolution for WaveSpeed API requirements
    if (payload.quality) {
      const q = String(payload.quality).toLowerCase();
      if (q === "standard") {
        payload.quality = "medium";
      } else if (q === "hd") {
        payload.quality = "high";
      } else if (q === "2k") {
        payload.quality = "medium";
        payload.resolution = "2k";
      } else if (q === "4k") {
        payload.quality = "high";
        payload.resolution = "4k";
      } else if (["low", "medium", "high"].includes(q)) {
        payload.quality = q;
      } else {
        payload.quality = "medium";
      }
    }

    return payload;
  }

  fromProviderResponse(rawResponse = {}, outputDef = {}) {
    if (!rawResponse || typeof rawResponse !== "object") {
      throw new OutputContractViolationError("WaveSpeed response is not an object");
    }

    const outputType = outputDef.type || "image";
    const url =
      (Array.isArray(rawResponse.outputs) && rawResponse.outputs[0]) ||
      rawResponse.output?.url ||
      rawResponse.url ||
      rawResponse.image_url;

    if (outputDef.fields?.url?.required && !url) {
      throw new OutputContractViolationError("WaveSpeed response missing required output field: 'url'");
    }

    return {
      type: outputType,
      url,
    };
  }
}

export const wavespeedAdapter = new WaveSpeedAdapter();
export default wavespeedAdapter;
