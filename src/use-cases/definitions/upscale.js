import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const upscaleUseCase = {
  useCaseId: "upscale-v1",
  label: "Image & Media Upscaling",
  description: "Enhances image quality and resolution with super-resolution AI models.",
  workflowRef: "upscale-v1",
  billing: {
    strategy: "per-node"
  },
  inputSchema: {
    factor: { type: "number", required: false, default: 2 }
  }
};

validateUseCaseDefinition(upscaleUseCase);
