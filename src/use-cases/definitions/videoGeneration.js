import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const videoGenerationUseCase = {
  useCaseId: "video-generation-v1",
  label: "Video Generation",
  description: "Generate cinematic videos from a text prompt with optional reference images.",
  workflowRef: "video-generation-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:      { type: "string",  required: true },
    references:  { type: "array",   required: false },
    workflow_id: { type: "string",  required: false },
    project_id:  { type: "string",  required: false },
    ratio:       { type: "string",  required: false },
    duration:    { type: "number",  required: false },
  }
};

validateUseCaseDefinition(videoGenerationUseCase);
