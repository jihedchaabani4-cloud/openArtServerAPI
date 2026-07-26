import { registerManifest, clearManifestRegistry } from "./nodeManifestRegistry.js";
import { promptBuilderManifest } from "./promptBuilderManifest.js";
import { imageGenerationManifest } from "./imageGenerationManifest.js";
import { videoGenerationManifest } from "./videoGenerationManifest.js";
import { upscaleManifest } from "./upscaleManifest.js";

/**
 * Registers all 5 node type manifests into the global registry.
 */
export function registerAllManifests() {
  clearManifestRegistry();

  const manifests = [
    promptBuilderManifest,
    imageGenerationManifest,
    videoGenerationManifest,
    upscaleManifest
  ];

  for (const manifest of manifests) {
    try {
      registerManifest(manifest);
      console.log(`[NodeManifestRegistry] Registered node manifest for: ${manifest.type}`);
    } catch (err) {
      console.error(`[NodeManifestRegistry] Failed to register manifest "${manifest.type}":`, err.message);
    }
  }
}
