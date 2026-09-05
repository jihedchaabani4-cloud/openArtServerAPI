import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADAPTERS_DIR = path.join(__dirname, "custom");

const adapterCache = new Map();

/**
 * Adapter Loader
 *
 * Loads custom JS adapter modules by name.
 * Adapters are the escape hatch for complex provider transformations that
 * cannot be expressed declaratively via parameterMap/valueMap.
 *
 * Adapter responsibilities:
 *   - toProviderPayload(cleanInput, binding) → providerPayload
 *   - fromProviderResponse(rawResponse, binding) → normalizedOutput
 *
 * Adapter must NOT handle:
 *   - wallet / credits / pricing
 *   - user authentication
 *   - workflow orchestration
 *
 * Resolution: adapters/<adapterName>.js OR absolute path.
 */
export async function getCustomAdapter(adapterName) {
  if (!adapterName) return null;

  if (adapterCache.has(adapterName)) {
    return adapterCache.get(adapterName);
  }

  const adapterPath = path.isAbsolute(adapterName)
    ? adapterName
    : path.join(ADAPTERS_DIR, adapterName);

  try {
    const adapterModule = await import(`file://${adapterPath}`);
    adapterCache.set(adapterName, adapterModule);
    return adapterModule;
  } catch (err) {
    throw new Error(`Failed to load custom adapter "${adapterName}": ${err.message}`);
  }
}

/**
 * Clear the adapter cache (useful in tests).
 */
export function clearAdapterCache() {
  adapterCache.clear();
}
