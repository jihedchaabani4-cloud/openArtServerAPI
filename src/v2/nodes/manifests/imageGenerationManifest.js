export const imageGenerationManifest = {
  type: "image-generation",
  version: "1.0.0",
  label: "Generate Image",
  description: "Generate images from a text prompt using AI",
  icon: "🎨",
  category: "generation",
  color: "#6366f1",
  badge: "PAID",
  billing: {
    type: "per-execution",
    unit: "count",
    pricedBy: ["model", "quality_tier"]
  },
  supportsAsync: true,
  supportsBatch: true,
  supportsStreaming: false,
  inputs: [
    { key: "prompt", type: "string", required: true, label: "Prompt" },
    { key: "count", type: "number", default: 1, label: "Count", min: 1, max: 8 },
    { key: "width", type: "number", default: 1024, label: "Width" },
    { key: "height", type: "number", default: 1024, label: "Height" },
    { key: "model", type: "enum", label: "Model", options: ["flux-dev", "flux-pro", "gpt-image", "imagen"] },
    { key: "quality", type: "enum", default: "standard", label: "Quality Tier", options: ["standard", "quality", "premium"] },
    { key: "references", type: "array", default: [], label: "References" },
    { key: "source_asset", type: "object", label: "Source Asset" },
    { key: "strength", type: "number", default: 0.75, label: "Edit Strength" },
    { key: "mode", type: "enum", label: "Mode", options: ["image_edit", "image_to_image", "image_variation"] },
    { key: "style_reference", type: "string", label: "Style Reference URL" },
    { key: "character_reference", type: "string", label: "Character Reference URL" }
  ],
  outputs: [
    { key: "assets", type: "array", label: "Generated Images" },
    { key: "metadata", type: "object", label: "Generation Metadata" }
  ],
  accepts: ["prompt-builder", "input-collector", "image-generation"],
  feeds: ["upscale", "image-generation", "save-to-library", "export"]
};
