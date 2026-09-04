import { registerUseCase, clearUseCaseRegistry } from "./useCaseRegistry.js";
import { characterSheetUseCase } from "./definitions/characterSheet.js";
import { imageGenerationUseCase } from "./definitions/imageGeneration.js";
import { createLogger } from "../infrastructure/logging/index.js";

const systemLogger = createLogger("system");

/**
 * Registers all active Use Cases into the global registry.
 */
export function registerAllUseCases() {
  clearUseCaseRegistry();

  const useCases = [
    characterSheetUseCase,
    imageGenerationUseCase,
  ];

  for (const uc of useCases) {
    try {
      registerUseCase(uc);
      systemLogger.debug({ useCaseId: uc.useCaseId }, `Registered Use Case: ${uc.useCaseId}`);
    } catch (err) {
      systemLogger.error({ useCaseId: uc.useCaseId, err }, `Failed to register Use Case "${uc.useCaseId}": ${err.message}`);
    }
  }
}

