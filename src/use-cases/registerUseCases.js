import { registerUseCase, clearUseCaseRegistry } from "./useCaseRegistry.js";
import { characterSheetUseCase } from "./definitions/characterSheet.js";
import { imageGenerationUseCase } from "./definitions/imageGeneration.js";
import { videoGenerationUseCase } from "./definitions/videoGeneration.js";
import { imageEditUseCase } from "./definitions/imageEdit.js";
import { videoEditUseCase } from "./definitions/videoEdit.js";
import { cameraControlUseCase } from "./definitions/cameraControl.js";
import { lightingControlUseCase } from "./definitions/lightingControl.js";
import { upscaleUseCase } from "./definitions/upscale.js";

/**
 * Registers all active Use Cases into the global registry.
 */
export function registerAllUseCases() {
  clearUseCaseRegistry();

  const useCases = [
    characterSheetUseCase,
    imageGenerationUseCase,
    videoGenerationUseCase,
    imageEditUseCase,
    videoEditUseCase,
    cameraControlUseCase,
    lightingControlUseCase,
    upscaleUseCase,
  ];

  for (const uc of useCases) {
    try {
      registerUseCase(uc);
      console.log(`[UseCaseRegistry] Registered Use Case: ${uc.useCaseId}`);
    } catch (err) {
      console.error(`[UseCaseRegistry] Failed to register Use Case "${uc.useCaseId}":`, err.message);
    }
  }
}
