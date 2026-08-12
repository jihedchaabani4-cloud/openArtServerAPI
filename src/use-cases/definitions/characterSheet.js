import { validateUseCaseDefinition } from "../useCaseSchema.js";

export const characterSheetUseCase = {
  useCaseId: "character-sheet-v1",
  label: "Character & Element Reference Sheet",
  description: "Generates multi-view reference sheets for characters and elements with consistent traits.",
  workflowRef: "character-sheet-v1",
  billing: {
    strategy: "per-node"
  },
  inputSchema: {
    prompt: { type: "string", required: true },
    model: { type: "string", required: false }
  }
};

validateUseCaseDefinition(characterSheetUseCase);
