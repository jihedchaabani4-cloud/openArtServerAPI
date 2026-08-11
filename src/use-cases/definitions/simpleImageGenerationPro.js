export const simpleImageGenerationProUseCase = {
  useCaseId: "simple-image-pro-v1",
  label: "Simple Image Generation (Pro Mode)",
  description: "AI-enhanced cinematic image generation powered by promptBuilderNode and LLM reasoning",
  category: "generation",
  type: "flow",
  thumbnail: "/thumbnails/simple-image-pro.jpg",
  status: "active",
  workflowRef: "simple-image-pro-v1",
  mode: "pro",
  billing: {
    strategy: "per-node",
  },
  inputSchema: {
    prompt: {
      type: "string",
      required: true,
      label: "Prompt",
    },
    skills: {
      type: "array",
      required: false,
      default: ["cinematic-image-prompt"],
    },
    aspect_ratio: {
      type: "enum",
      required: false,
      default: "16:9",
      options: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
    },
  },
  version: "1.0.0",
  author: "system",
  tags: ["image", "generation", "pro-mode", "llm"],
  visibility: "public",
};

export default simpleImageGenerationProUseCase;
