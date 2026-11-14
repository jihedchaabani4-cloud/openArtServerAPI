import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const videoGenerationUseCase = {
  useCaseId: "video-generation-v1",
  label: "Video Generation",
  description: "Generate high-quality videos from a text prompt with optional keyframe images and references.",
  workflowRef: "video-generation-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:     { type: "string", required: true  },
    model:      { type: "string", required: true  },
    references: { type: "array",  required: false },
    parameters: { type: "object", required: false }, // model-specific params — validated by Model Management
  }
};

validateUseCaseDefinition(videoGenerationUseCase);
