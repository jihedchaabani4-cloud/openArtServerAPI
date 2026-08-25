export class GoogleAdapter {
  toProviderPayload(cleanInput = {}) {
    return {
      instances: [{ prompt: cleanInput.prompt }],
      parameters: { sampleCount: 1, aspectRatio: cleanInput.aspect_ratio || "1:1" }
    };
  }
  fromProviderResponse(raw = {}) {
    return { type: "image", url: raw.predictions?.[0]?.bytesBase64Encoded || raw.url };
  }
}
export const googleAdapter = new GoogleAdapter();
