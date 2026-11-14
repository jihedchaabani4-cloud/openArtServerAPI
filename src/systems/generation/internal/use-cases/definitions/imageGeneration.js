import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const imageGenerationUseCase = {
  useCaseId: "image-generation-v1",
  label: "Image Generation",
  description: "Generate high-quality images from a text prompt with optional reference images.",
  workflowRef: "image-generation-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:     { type: "string", required: true  },
    model:      { type: "string", required: true  },
    references: { type: "array",  required: false },
    parameters: { type: "object", required: false }, // model-specific params — validated by Model Management
  }
};

validateUseCaseDefinition(imageGenerationUseCase);
