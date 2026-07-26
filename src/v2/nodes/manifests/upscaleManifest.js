export const upscaleManifest = {
  type: "upscale",
  version: "1.0.0",
  label: "Upscale / Enhance",
  description: "Enhance image and video files to high resolution and clarity",
  icon: "📈",
  category: "enhancement",
  color: "#eab308",
  badge: "PAID",
  billing: {
    type: "per-execution",
    unit: "factor",
    pricedBy: ["provider"]
  },
  supportsAsync: true,
  supportsBatch: false,
  supportsStreaming: false,
  inputs: [
    { key: "asset", type: "object", required: true, label: "Asset to Upscale" },
    { key: "factor", type: "number", default: 2, label: "Upscale Factor", options: [2, 4] },
    { key: "quality", type: "string", default: "standard", label: "Quality Level" }
  ],
  outputs: [
    { key: "enhancedAsset", type: "object", label: "Upscaled Asset" },
    { key: "metadata", type: "object", label: "Metadata" }
  ],
  accepts: ["image-generation", "video-generation"],
  feeds: ["media-transform", "save-to-library", "export"]
};
