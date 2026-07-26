export const promptBuilderManifest = {
  type: "prompt-builder",
  version: "1.0.0",
  label: "Prompt Builder",
  description: "Construct and polish input prompts from inputs, references, characters, and styles",
  icon: "📝",
  category: "processing",
  color: "#f97316",
  badge: "FREE",
  billing: {
    type: "free",
    unit: null,
    pricedBy: []
  },
  supportsAsync: false,
  supportsBatch: false,
  supportsStreaming: false,
  inputs: [
    { key: "prompt", type: "string", required: true, label: "Prompt" },
    { key: "references", type: "array", default: [], label: "References" },
    { key: "characters", type: "array", default: [], label: "Characters" },
    { key: "style", type: "string", label: "Style" },
    { key: "source_asset", type: "object", label: "Source Asset" }
  ],
  outputs: [
    { key: "finalPrompt", type: "string", label: "Final Prompt" },
    { key: "context", type: "object", label: "Workflow Context" }
  ],
  accepts: ["input-collector"],
  feeds: ["image-generation", "video-generation", "media-transform"]
};
