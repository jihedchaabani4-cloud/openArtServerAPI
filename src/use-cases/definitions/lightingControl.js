import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const lightingControlUseCase = {
  useCaseId: "lighting-control-v1",
  label: "Lighting Control",
  description: "Generate images with precise lighting mood control — studio, golden hour, neon, and more.",
  workflowRef: "lighting-control-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:          { type: "string",  required: true },
    references:      { type: "array",   required: false },
    workflow_id:     { type: "string",  required: false },
    project_id:      { type: "string",  required: false },
    lighting_style:  { type: "string",  required: false },
    time_of_day:     { type: "string",  required: false },
    ratio:           { type: "string",  required: false },
  }
};

validateUseCaseDefinition(lightingControlUseCase);
