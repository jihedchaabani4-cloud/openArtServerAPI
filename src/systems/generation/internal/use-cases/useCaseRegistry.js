import { validateUseCaseDefinition } from "./useCaseSchema.js";

const registry = new Map();

/**
 * Registers a new Use Case definition into the global registry.
 * Validates the definition before registration and stores a frozen copy.
 */
export function registerUseCase(def) {
  validateUseCaseDefinition(def);
  
  if (registry.has(def.useCaseId)) {
    throw new Error(`Use Case with ID "${def.useCaseId}" is already registered.`);
  }

  // Freeze the object to ensure metadata-only immutability
  const frozenDef = Object.freeze(JSON.parse(JSON.stringify(def)));
  registry.set(def.useCaseId, frozenDef);
  return frozenDef;
}

/**
 * Retrieves a registered Use Case definition by its ID.
 */
export function getUseCase(id) {
  return registry.get(id) || null;
}

/**
 * Lists registered Use Cases, optionally filtering by category, type, and status.
 */
export function listUseCases({ category, type, includeHidden = false } = {}) {
  const list = [];
  for (const def of registry.values()) {
    // Filter hidden unless includeHidden is true
    if (def.status === "hidden" && !includeHidden) {
      continue;
    }
    // Filter by category if specified
    if (category && def.category !== category) {
      continue;
    }
    // Filter by type if specified
    if (type && def.type !== type) {
      continue;
    }
    list.push(def);
  }
  return list;
}

/**
 * Clears the registry (useful for testing/reload purposes).
 */
export function clearUseCaseRegistry() {
  registry.clear();
}
