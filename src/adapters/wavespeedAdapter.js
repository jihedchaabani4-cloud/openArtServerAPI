import { OutputContractViolationError } from "../models/errors/index.js";

export class WaveSpeedAdapter {
  toProviderPayload(cleanInput = {}, fieldMapping = {}) {
    const payload = {};
    for (const [key, val] of Object.entries(cleanInput)) {
      const targetKey = fieldMapping[key] || key;
      payload[targetKey] = val;
    }
    return payload;
  }

  fromProviderResponse(rawResponse = {}, outputDef = {}) {
    if (!rawResponse || typeof rawResponse !== "object") {
      throw new OutputContractViolationError("WaveSpeed response is not an object");
    }

    const outputType = outputDef.type || "image";
    const url = rawResponse.output?.url || rawResponse.url || rawResponse.image_url;

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
