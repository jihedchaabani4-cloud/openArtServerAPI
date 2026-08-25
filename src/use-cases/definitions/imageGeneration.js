import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const imageGenerationUseCase = {
  useCaseId: "image-generation-v1",
  label: "Image Generation",
  description: "Generate high-quality images from a text prompt with optional reference images.",
  workflowRef: "image-generation-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:      { type: "string",  required: true },
    references:  { type: "array",   required: false },
    workflow_id: { type: "string",  required: false },
    project_id:  { type: "string",  required: false },
    ratio:       { type: "string",  required: false },
    width:       { type: "number",  required: false },
    height:      { type: "number",  required: false },
    model:       { type: "string",  required: false },
    quality:     { type: "string",  required: false },
    count:       { type: "number",  required: false },
  }
};

validateUseCaseDefinition(imageGenerationUseCase);
