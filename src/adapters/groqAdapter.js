export class GroqAdapter {
  toProviderPayload(cleanInput = {}) {
    return {
      messages: cleanInput.messages,
      temperature: cleanInput.temperature ?? 0.7,
    };
  }
  fromProviderResponse(raw = {}) {
    return {
      type: "text",
      content: raw.choices?.[0]?.message?.content || "",
      usage: raw.usage ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens } : undefined,
    };
  }
}
export const groqAdapter = new GroqAdapter();
