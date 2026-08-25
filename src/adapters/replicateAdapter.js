export class ReplicateAdapter {
  toProviderPayload(cleanInput = {}) {
    return {
      input: cleanInput
    };
  }
  fromProviderResponse(raw = {}, outputDef = {}) {
    const url = Array.isArray(raw.output) ? raw.output[0] : (raw.output || raw.url);
    return {
      type: outputDef.type || "image",
      url: url || "",
    };
  }
}
export const replicateAdapter = new ReplicateAdapter();
