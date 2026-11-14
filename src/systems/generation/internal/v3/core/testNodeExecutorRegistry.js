/**
 * Mock & Test Node Executor Registry (V3)
 *
 * Allows unit and integration tests to register hermetic mocks for nodes
 * without contacting external AI model providers (WaveSpeed, Google Gemini, Fal, etc.).
 */

export const mockNodeRegistry = new Map();

export function registerNodeExecutor(type, fn) {
  if (typeof fn === "function") {
    mockNodeRegistry.set(type, fn);
  } else {
    mockNodeRegistry.delete(type);
  }
}

export function getMockNodeExecutor(type) {
  return mockNodeRegistry.get(type);
}

export function clearMockNodeExecutors() {
  mockNodeRegistry.clear();
}

/**
 * Normalizes output from a mock executor to match V3 node RETURN_TYPES.
 */
export function normalizeMockOutput(nodeType, mockResult, inputs = {}) {
  if (!mockResult || typeof mockResult !== "object") {
    return mockResult || {};
  }

  if (nodeType === "base.image_generate") {
    const assets = Array.isArray(mockResult.assets)
      ? mockResult.assets
      : Array.isArray(mockResult.images)
        ? mockResult.images.map((u) => (typeof u === "string" ? { url: u } : u))
        : mockResult.url
          ? [{ url: mockResult.url, width: mockResult.width, height: mockResult.height }]
          : [];
    const imageUrl = mockResult.image_url || assets[0]?.url || (typeof assets[0] === "string" ? assets[0] : null);
    return {
      image_url: imageUrl,
      assets,
      metadata: mockResult.metadata || { width: mockResult.width, height: mockResult.height },
    };
  }

  if (nodeType === "base.video_generate") {
    const assets = Array.isArray(mockResult.assets)
      ? mockResult.assets
      : mockResult.url
        ? [{ url: mockResult.url }]
        : [];
    const videoUrl = mockResult.video_url || assets[0]?.url || mockResult.url || null;
    return {
      video_url: videoUrl,
      assets,
      metadata: mockResult.metadata || {},
    };
  }

  if (nodeType === "base.llm_text" || nodeType === "base.llm_vision") {
    const text =
      mockResult.json?.description ||
      mockResult.text ||
      mockResult.content ||
      inputs.prompt ||
      "";
    const json =
      mockResult.json ||
      { prompt: text, description: text };
    return {
      text,
      json,
      metadata: mockResult.metadata || { model: inputs.model || "gemini-3.1-flash-lite" },
    };
  }

  if (nodeType === "base.safety_check") {
    return {
      safe_prompt: mockResult.safe_prompt || inputs.prompt || "",
      is_safe: mockResult.is_safe !== false,
    };
  }

  return mockResult;
}
