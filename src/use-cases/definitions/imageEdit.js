import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const imageEditUseCase = {
  useCaseId: "image-edit-v1",
  label: "Image Edit",
  description: "Edit an existing image using a text prompt — change style, object, or background.",
  workflowRef: "image-edit-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    model:       { type: "string",  required: true },
    prompt:      { type: "string",  required: true },
    source_url:  { type: "string",  required: true },
    references:  { type: "array",   required: false },
    workflow_id: { type: "string",  required: false },
    project_id:  { type: "string",  required: false },
    ratio:       { type: "string",  required: false },
  }
};

validateUseCaseDefinition(imageEditUseCase);
