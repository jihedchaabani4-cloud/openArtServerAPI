import { registerUseCase, clearUseCaseRegistry } from "./useCaseRegistry.js";
import { brandMascotUseCase } from "./definitions/brandMascot.js";
import { productAdVideosUseCase } from "./definitions/productAdVideos.js";
import { vfxStudioUseCase } from "./definitions/vfxStudio.js";

/**
 * Registers all pre-defined Use Cases into the global registry.
 */
export function registerAllUseCases() {
  // Clear any existing registrations to allow clean bootstrap reload
  clearUseCaseRegistry();

  const useCases = [
    brandMascotUseCase,
    productAdVideosUseCase,
    vfxStudioUseCase
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
