import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const lightingControlUseCase = {
  useCaseId: "lighting-control-v1",
  label: "Lighting Control & Relighting",
  description: "Relights existing images with light angle, elevation, intensity, type, brightness, and color.",
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

validateUseCaseDefinition(lightingControlUseCase);
