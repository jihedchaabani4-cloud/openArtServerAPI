const registry = new Map();

/**
 * Validates a node manifest structure.
 */
function validateManifest(manifest) {
  if (!manifest) {
    throw new Error("Manifest is required");
  }
  if (!manifest.type || typeof manifest.type !== "string") {
    throw new Error("Manifest is missing required field: 'type' (string)");
  }
  if (!manifest.label || typeof manifest.label !== "string") {
    throw new Error("Manifest is missing required field: 'label' (string)");
  }
  if (!manifest.billing || typeof manifest.billing.type !== "string") {
    throw new Error("Manifest is missing required field: 'billing.type' (string)");
  }
}

/**
 * Registers a node manifest.
 */
export function registerManifest(manifest) {
  validateManifest(manifest);

  if (registry.has(manifest.type)) {
    throw new Error(`Node manifest for type "${manifest.type}" is already registered.`);
  }

  // Freeze the object to prevent modifications
  const frozenManifest = Object.freeze(JSON.parse(JSON.stringify(manifest)));
  registry.set(manifest.type, frozenManifest);
  return frozenManifest;
}

/**
 * Gets a registered node manifest by node type.
 */
export function getManifest(type) {
  return registry.get(type) || null;
}

/**
 * Lists all registered node manifests.
 */
export function listManifests() {
  return Array.from(registry.values());
}

/**
 * Clears the registry (useful for testing).
 */
export function clearManifestRegistry() {
  registry.clear();
}
