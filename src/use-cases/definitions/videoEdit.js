import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const videoEditUseCase = {
  useCaseId: "video-edit-v1",
  label: "Video Edit",
  description: "Edit or restyle an existing video using a text prompt.",
  workflowRef: "video-edit-v1",
  billing: { strategy: "per-node" },
  inputSchema: {
    model:       { type: "string",  required: true },
    prompt:      { type: "string",  required: true },
    source_url:  { type: "string",  required: true },
    workflow_id: { type: "string",  required: false },
    project_id:  { type: "string",  required: false },
  }
};

validateUseCaseDefinition(videoEditUseCase);
