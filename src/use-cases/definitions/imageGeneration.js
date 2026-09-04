import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const imageGenerationUseCase = {
  useCaseId: "image-generation-v1",
  label: "Image Generation",
  description: "Generate high-quality images from a text prompt with optional reference images.",
  workflowRef: "image-generation-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:     { type: "string", required: true  },
    references: { type: "array",  required: false },
    ratio:      { type: "string", required: false },
    model:      { type: "string", required: true  },
    quality:    { type: "string", required: false },
    count:      { type: "number", required: false },
  }
};

validateUseCaseDefinition(imageGenerationUseCase);
