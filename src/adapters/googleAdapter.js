export class GoogleAdapter {
  toProviderPayload(cleanInput = {}) {
    if (cleanInput.messages) {
      const parts = [];
      for (const m of cleanInput.messages) {
        parts.push({ text: `${m.role ? m.role.toUpperCase() + ': ' : ''}${m.content}` });
      }
      if (Array.isArray(cleanInput.images) && cleanInput.images.length > 0) {
        for (const img of cleanInput.images) {
          if (typeof img === "string" && img.startsWith("data:")) {
            const match = img.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          } else if (typeof img === "string") {
            parts.push({ text: `[Reference Image]: ${img}` });
          }
        }
      }
      return {
        contents: [{ parts }],
        config: {
          temperature: cleanInput.temperature ?? 0.7,
        },
      };
    }
    return {
      prompt: cleanInput.prompt,
      config: {
        aspectRatio: cleanInput.aspect_ratio || "1:1",
      },
    };
  }

  fromProviderResponse(raw = {}) {
    if (raw.text !== undefined && typeof raw.text === "string") {
      return {
        type: "text",
        content: raw.text,
        usage: raw.usageMetadata
          ? {
              inputTokens: raw.usageMetadata.promptTokenCount,
              outputTokens: raw.usageMetadata.candidatesTokenCount,
            }
          : undefined,
      };
    }
    if (raw.candidates) {
      const text = raw.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return {
        type: "text",
        content: text,
        usage: raw.usageMetadata
          ? {
              inputTokens: raw.usageMetadata.promptTokenCount,
              outputTokens: raw.usageMetadata.candidatesTokenCount,
            }
          : undefined,
      };
    }
    return { type: "image", url: raw.predictions?.[0]?.bytesBase64Encoded || raw.url };
  }
}
export const googleAdapter = new GoogleAdapter();
