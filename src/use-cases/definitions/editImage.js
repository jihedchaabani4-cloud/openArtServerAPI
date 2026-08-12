import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const editImageUseCase = {
  useCaseId: "edit-image-v1",
  label: "Image Editing & Inpainting",
  description: "Edits existing images with prompts, masks, references, and style transforms.",
  workflowRef: "edit-image-v1",
  billing: {
    strategy: "per-node"
  },
  inputSchema: {
    prompt: { type: "string", required: true },
    model: { type: "string", required: false },
    aspect_ratio: { type: "enum", options: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"], default: "1:1" }
  }
};

validateUseCaseDefinition(editImageUseCase);
