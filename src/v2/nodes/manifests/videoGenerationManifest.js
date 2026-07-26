export const videoGenerationManifest = {
  type: "video-generation",
  version: "1.0.0",
  label: "Generate Video",
  description: "Generate video clips from a text prompt or an image",
  icon: "🎬",
  category: "generation",
  color: "#6366f1",
  badge: "PAID",
  billing: {
    type: "per-execution",
    unit: "duration",
    pricedBy: ["model", "quality_tier"]
  },
  supportsAsync: true,
  supportsBatch: false,
  supportsStreaming: false,
  inputs: [
    { key: "prompt", type: "string", required: true, label: "Prompt" },
    { key: "duration", type: "number", default: 5, label: "Duration", min: 1, max: 60 },
    { key: "fps", type: "number", default: 24, label: "FPS" },
    { key: "aspect_ratio", type: "string", default: "16:9", label: "Aspect Ratio" },
    { key: "mode", type: "enum", default: "t2v", label: "Mode", options: ["t2v", "i2v"] },
    { key: "model", type: "enum", label: "Model", options: ["runway-gen3", "kling", "veo3"] },
    { key: "startFrame", type: "object", label: "Start Frame Image" }
  ],
  outputs: [
    { key: "asset", type: "object", label: "Generated Video Asset" },
    { key: "metadata", type: "object", label: "Metadata" }
  ],
  accepts: ["prompt-builder", "input-collector"],
  feeds: ["upscale", "save-to-library", "export"]
};
