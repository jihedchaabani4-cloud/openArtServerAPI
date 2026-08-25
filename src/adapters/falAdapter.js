export class FalAdapter {
  toProviderPayload(cleanInput = {}) {
    return cleanInput;
  }
  fromProviderResponse(raw = {}) {
    return { type: "image", url: raw.images?.[0]?.url || raw.url };
  }
}
export const falAdapter = new FalAdapter();
