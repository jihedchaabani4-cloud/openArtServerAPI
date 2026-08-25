import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const upscaleUseCase = {
  useCaseId: "upscale-v1",
  label: "Image Upscale",
  description: "AI-powered image upscaling — enhance resolution up to 4x with super-resolution.",
  workflowRef: "upscale-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    source_url:  { type: "string",  required: true },
    workflow_id: { type: "string",  required: false },
    project_id:  { type: "string",  required: false },
    factor:      { type: "number",  required: false },
  }
};

validateUseCaseDefinition(upscaleUseCase);
