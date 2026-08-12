import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const cameraControlUseCase = {
  useCaseId: "camera-control-v1",
  label: "Camera Control Adjustments",
  description: "Applies camera angle changes, rotation, tilt, and zoom to existing images and videos.",
  workflowRef: "edit-image-v1",
  billing: {
    strategy: "per-node"
  },
  inputSchema: {
    source_asset: { type: "string", required: true },
    prompt: { type: "string", required: false },
    model: { type: "string", required: false },
    aspect_ratio: { type: "enum", options: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"], default: "1:1" }
  }
};

validateUseCaseDefinition(cameraControlUseCase);
