import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const cameraControlUseCase = {
  useCaseId: "camera-control-v1",
  label: "Camera Control",
  description: "Generate images with precise cinematic camera control — angle, shot type, and lens.",
  workflowRef: "camera-control-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    prompt:        { type: "string",  required: true },
    references:    { type: "array",   required: false },
    workflow_id:   { type: "string",  required: false },
    project_id:    { type: "string",  required: false },
    camera_angle:  { type: "string",  required: false },
    shot_type:     { type: "string",  required: false },
    lens:          { type: "string",  required: false },
    ratio:         { type: "string",  required: false },
  }
};

validateUseCaseDefinition(cameraControlUseCase);
