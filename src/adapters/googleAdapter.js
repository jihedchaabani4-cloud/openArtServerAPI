export class GoogleAdapter {
  toProviderPayload(cleanInput = {}) {
    if (cleanInput.messages) {
      const parts = cleanInput.messages.map((m) => ({
        text: `${m.role.toUpperCase()}: ${m.content}`,
      }));
      return {
        contents: [{ parts }],
        generationConfig: {
          temperature: cleanInput.temperature ?? 0.7,
        },
      };
    }
    return {
      instances: [{ prompt: cleanInput.prompt }],
      parameters: { sampleCount: 1, aspectRatio: cleanInput.aspect_ratio || "1:1" }
    };
  }

  fromProviderResponse(raw = {}) {
    if (raw.candidates) {
      const text = raw.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return {
        type: "text",
        content: text,
      };
    }
    return { type: "image", url: raw.predictions?.[0]?.bytesBase64Encoded || raw.url };
  }
}
export const googleAdapter = new GoogleAdapter();
