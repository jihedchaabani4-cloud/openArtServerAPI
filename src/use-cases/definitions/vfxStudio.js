export const vfxStudioUseCase = {
  useCaseId: "vfx-studio",
  label: "VFX Studio",
  description: "Transform and edit media files using advanced style transfer and effects",
  category: "creative",
  type: "flow",
  thumbnail: "/thumbnails/vfx-studio.jpg",
  status: "active",
  workflowRef: "vfx-studio-v1",
  billing: {
    strategy: "per-node",
  },
  inputSchema: {
    prompt: {
      type: "string",
      required: true,
      label: "Effect / Transformation Prompt",
      placeholder: "e.g. make it look like a futuristic hologram with blue neon lines"
    },
    source_url: {
      type: "string",
      required: true,
      label: "Source Image URL"
    },
    strength: {
      type: "number",
      default: 0.75,
      min: 0.1,
      max: 1.0,
      label: "Effect Strength"
    }
  },
  version: "1.0.0",
  author: "system",
  tags: ["creative", "vfx", "edit"],
  visibility: "public"
};
