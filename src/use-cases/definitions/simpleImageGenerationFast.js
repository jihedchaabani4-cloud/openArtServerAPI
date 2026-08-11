export const simpleImageGenerationFastUseCase = {
  useCaseId: "simple-image-fast-v1",
  label: "Simple Image Generation (Fast Mode)",
  description: "Ultra-fast image generation bypassing LLM reasoning (0 LLM cost & minimal latency)",
  category: "generation",
  type: "flow",
  thumbnail: "/thumbnails/simple-image-fast.jpg",
  status: "active",
  workflowRef: "simple-image-fast-v1",
  mode: "fast",
  billing: {
    strategy: "per-node",
  },
  inputSchema: {
    prompt: {
      type: "string",
      required: true,
      label: "Prompt",
    },
    aspect_ratio: {
      type: "enum",
      required: false,
      default: "1:1",
      options: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
    },
  },
  version: "1.0.0",
  author: "system",
  tags: ["image", "generation", "fast-mode"],
  visibility: "public",
};

export default simpleImageGenerationFastUseCase;
