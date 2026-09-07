import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  UnknownProviderReferenceError,
  UnknownOperationReferenceError,
  UnknownCanonicalParameterError,
  DuplicateBindingError,
  UnknownModelFamilyError,
  PriorityConflictError,
  MissingOutputMapError,
  ConfigIntegrityError
} from "../errors/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MODELS_ROOT = path.resolve(__dirname, "..");

let registryState = {
  isInitialized: false,
  models: new Map(),
  modelAliases: new Map(),
  providers: new Map(),
  sharedParams: new Map(),
  bindings: new Map(),
  bindingIndex: new Map(), // key: `${modelId}:${operation}` -> Array<Binding> sorted by priority
  modelBindings: new Map(), // key: `${modelId}` -> Array<Binding> sorted by priority
};

/**
 * Initializes and builds in-memory registry from disk manifests.
 * Enforces strict fail-fast validation rules.
 */
export function initRegistry(options = {}) {
  const rootDir = options.rootDir || DEFAULT_MODELS_ROOT;
  const manifestsDir = options.manifestsDir || path.join(rootDir, "manifests");
  const providersDir = options.providersDir || path.join(rootDir, "providers");
  const sharedDir = options.sharedDir || path.join(rootDir, "shared");

  if (registryState.isInitialized && !options.forceReload) {
    return getRegistry();
  }

  const providers = new Map();
  const sharedParams = new Map();
  const models = new Map();
  const modelAliases = new Map();
  const bindings = new Map();
  const bindingIndex = new Map();
  const modelBindings = new Map();

  // 1. Load Providers
  if (fs.existsSync(providersDir)) {
    const providerFiles = fs.readdirSync(providersDir).filter((f) => f.endsWith(".json"));
    for (const file of providerFiles) {
      const fullPath = path.join(providersDir, file);
      const content = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (content.id) {
        providers.set(content.id, { ...content, _sourcePath: fullPath });
      }
    }
  }

  // 2. Load Shared Parameters
  if (fs.existsSync(sharedDir)) {
    const sharedFiles = fs.readdirSync(sharedDir).filter((f) => f.endsWith(".json"));
    for (const file of sharedFiles) {
      const fullPath = path.join(sharedDir, file);
      const content = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (content.domain && content.parameters) {
        sharedParams.set(content.domain, content.parameters);
      }
    }
  }

  // 3. Load Models and their Bindings
  if (fs.existsSync(manifestsDir)) {
    const modelFolders = fs.readdirSync(manifestsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const modelId of modelFolders) {
      const modelPath = path.join(manifestsDir, modelId, "model.json");
      if (!fs.existsSync(modelPath)) continue;

      const modelDef = JSON.parse(fs.readFileSync(modelPath, "utf8"));
      modelDef.id = modelDef.id || modelId;
      modelDef._sourcePath = modelPath;

      // Validation: Reject Model capability keys that match provider operation taxonomy
      if (modelDef.capabilities && typeof modelDef.capabilities === "object") {
        const FORBIDDEN_OPERATION_TAXONOMY_REGEX = /^(?:text_to_|image_to_|video_to_|edit$|inpaint$|upscale$)/i;
        const FORBIDDEN_SPECIFIC_KEYS = new Set([
          "text_to_image",
          "image_to_image",
          "image_to_video",
          "text_to_video",
          "video_to_video",
          "edit",
          "inpaint",
          "upscale",
          "image_upscale",
          "video_upscale",
        ]);

        for (const capKey of Object.keys(modelDef.capabilities)) {
          if (FORBIDDEN_SPECIFIC_KEYS.has(capKey) || FORBIDDEN_OPERATION_TAXONOMY_REGEX.test(capKey)) {
            throw new ConfigIntegrityError(
              `Model "${modelDef.id}" capability contains forbidden provider operation taxonomy key "${capKey}". ` +
              `Model capabilities must be semantic only (e.g. input_image, reference_images, mask).`
            );
          }
        }
      }

      models.set(modelDef.id, modelDef);

      if (Array.isArray(modelDef.aliases)) {
        for (const alias of modelDef.aliases) {
          modelAliases.set(alias, modelDef.id);
        }
      }

      // Load nested bindings
      const bindingsDir = path.join(manifestsDir, modelId, "bindings");
      if (fs.existsSync(bindingsDir)) {
        const bindingFiles = fs.readdirSync(bindingsDir).filter((f) => f.endsWith(".json"));
        for (const file of bindingFiles) {
          const bindingPath = path.join(bindingsDir, file);
          const bindingDef = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
          bindingDef.modelId = bindingDef.modelId || modelDef.id;
          bindingDef.id = bindingDef.id || `${bindingDef.modelId}.${bindingDef.providerId}`;
          bindingDef._sourcePath = bindingPath;

          const compositeKey = `${bindingDef.modelId}:${bindingDef.operation}:${bindingDef.providerId}`;

          // Validation Rule 4: Duplicate Composite Key Check
          if (bindings.has(compositeKey)) {
            throw new DuplicateBindingError(bindingDef.modelId, bindingDef.operation, bindingDef.providerId);
          }

          bindings.set(compositeKey, bindingDef);

          // Group by modelId:operation
          const indexKey = `${bindingDef.modelId}:${bindingDef.operation}`;
          if (!bindingIndex.has(indexKey)) {
            bindingIndex.set(indexKey, []);
          }
          bindingIndex.get(indexKey).push(bindingDef);

          // Group by modelId directly
          if (!modelBindings.has(bindingDef.modelId)) {
            modelBindings.set(bindingDef.modelId, []);
          }
          modelBindings.get(bindingDef.modelId).push(bindingDef);
        }
      }
    }
  }

  // 4. Strict Fail-Fast Validation & Sorting
  for (const [indexKey, bindingList] of bindingIndex.entries()) {
    const [mId, op] = indexKey.split(":");
    const model = models.get(mId);

    // Sort bindings by priority ascending (1 is highest priority), tie-break alphabetically by providerId
    bindingList.sort(
      (a, b) => (a.priority || 999) - (b.priority || 999) || (a.providerId || "").localeCompare(b.providerId || "")
    );

    // Validation: Unambiguous Active Configuration (Phase 1)
    // Exactly one active provider binding is permitted per (model, operation).
    const activeBindings = bindingList.filter((b) => b.status === "active");
    if (activeBindings.length > 1) {
      throw new ConfigIntegrityError(
        `Ambiguous active configuration: multiple active bindings found for model "${mId}" (${op}): ` +
        `[${activeBindings.map((b) => b.providerId).join(", ")}]. Exactly one active provider binding is permitted per operation.`
      );
    }

    // Validation Rule 5: Priority conflict check (hard error on conflict)
    const priorityCounts = {};
    for (const b of bindingList) {
      if (b.status === "active") {
        priorityCounts[b.priority] = (priorityCounts[b.priority] || 0) + 1;
        if (priorityCounts[b.priority] > 1) {
          throw new PriorityConflictError(mId, op, b.priority);
        }
      }

      // Validation Rule 1: Provider exists
      if (!providers.has(b.providerId)) {
        throw new UnknownProviderReferenceError(b.providerId, `binding (${compositeKeyFrom(b)})`);
      }

      // Validation Rule 2: Operation exists in canonical model
      if (!model || !model.operations || !model.operations[op]) {
        throw new UnknownOperationReferenceError(mId, op);
      }

      // Validation Rule 3: Canonical inputs check
      const opDef = model.operations[op];
      const domainShared = sharedParams.get(model.domain) || {};
      const canonicalInputs = opDef.canonicalInputs || {};

      const validateParamMap = (paramMap) => {
        if (!paramMap) return;
        for (const [canonicalKey, mapDef] of Object.entries(paramMap)) {
          const isDeclaredInOp = Object.prototype.hasOwnProperty.call(canonicalInputs, canonicalKey);
          const isDeclaredInModel = model.canonicalInputs && Object.prototype.hasOwnProperty.call(model.canonicalInputs, canonicalKey);
          const isDeclaredInShared = Object.prototype.hasOwnProperty.call(domainShared, canonicalKey);

          if (!isDeclaredInOp && !isDeclaredInModel && !isDeclaredInShared) {
            throw new UnknownCanonicalParameterError(mId, op, canonicalKey);
          }

          // Anti-Widening Invariant: If binding declares valueMap, ensure values are supported by model canonicalInputs
          const inputDef = canonicalInputs[canonicalKey] || model.canonicalInputs?.[canonicalKey];
          if (mapDef && mapDef.valueMap && inputDef?.values) {
            const modelAllowedValues = inputDef.values.map(String);
            for (const valueMapKey of Object.keys(mapDef.valueMap)) {
              if (!modelAllowedValues.includes(String(valueMapKey))) {
                throw new ConfigIntegrityError(
                  `Binding "${b.providerId}" for model "${mId}" (${op}) attempts to widen parameter "${canonicalKey}" with unsupported value "${valueMapKey}". Model allowed: ${modelAllowedValues.join(", ")}`
                );
              }
            }
          }
        }
      };

      if (b.parameterMap) {
        validateParamMap(b.parameterMap);
      }
      if (Array.isArray(b.routes)) {
        const seenRouteIds = new Set();
        for (const route of b.routes) {
          if (!route.id || typeof route.id !== "string") {
            throw new ConfigIntegrityError(
              `Route in binding "${b.providerId}" for model "${mId}" (${op}) is missing a valid string "id".`
            );
          }
          if (seenRouteIds.has(route.id)) {
            throw new ConfigIntegrityError(
              `Duplicate route id "${route.id}" found in binding "${b.providerId}" for model "${mId}" (${op}).`
            );
          }
          seenRouteIds.add(route.id);

          if (route.when && typeof route.when === "object") {
            for (const [condKey, condVal] of Object.entries(route.when)) {
              if (
                condVal !== "present" &&
                condVal !== "absent" &&
                typeof condVal !== "string" &&
                typeof condVal !== "number" &&
                typeof condVal !== "boolean" &&
                !(typeof condVal === "object" && condVal !== null && condVal.equals !== undefined)
              ) {
                throw new ConfigIntegrityError(
                  `Invalid condition for key "${condKey}" in route "${route.id}" of binding "${b.providerId}": ${JSON.stringify(condVal)}`
                );
              }
            }
          }

          if (route.parameterMap) {
            validateParamMap(route.parameterMap);
          }
        }
      }

      // Validation Rule 6: Mandatory outputMap check
      const effectiveOutputMap = b.outputMap || (b.routes && b.routes[0]?.outputMap);
      if (!effectiveOutputMap || typeof effectiveOutputMap !== "object" || Object.keys(effectiveOutputMap).length === 0) {
        throw new MissingOutputMapError(mId, op, b.providerId);
      }
    }
  }

  registryState = {
    isInitialized: true,
    models,
    modelAliases,
    providers,
    sharedParams,
    bindings,
    bindingIndex,
    modelBindings,
  };

  return getRegistry();
}

function compositeKeyFrom(b) {
  return `${b.modelId}:${b.operation}:${b.providerId}`;
}

export function getRegistry() {
  if (!registryState.isInitialized) {
    initRegistry();
  }
  return registryState;
}

export function getModel(modelId) {
  const { models, modelAliases } = getRegistry();
  if (!modelId || typeof modelId !== "string") {
    throw new UnknownModelFamilyError(String(modelId));
  }

  let model = models.get(modelId);
  if (!model) {
    const normalized = modelId.replace(/-/g, "_");
    model = models.get(normalized) || models.get(modelId.replace(/_/g, "-"));

    if (!model && modelAliases) {
      const canonicalId = modelAliases.get(modelId) || modelAliases.get(normalized);
      if (canonicalId) {
        model = models.get(canonicalId);
      }
    }
  }

  if (!model) {
    throw new UnknownModelFamilyError(modelId);
  }
  return model;
}

export function getProvider(providerId) {
  const { providers } = getRegistry();
  const provider = providers.get(providerId);
  if (!provider) {
    throw new UnknownProviderReferenceError(providerId);
  }
  return provider;
}

/**
 * Returns all configured provider bindings for a given model (deduplicated by providerId,
 * sorted by priority ascending).
 *
 * @param {string} modelId
 * @returns {object[]}
 */
export function getModelBindings(modelId) {
  const { modelBindings } = getRegistry();
  const model = getModel(modelId);
  const actualId = model ? model.id : modelId;
  const list = modelBindings?.get(actualId) || [];
  const seen = new Set();
  const result = [];
  for (const b of list) {
    const key = `${b.modelId}:${b.providerId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(b);
    }
  }
  return result.sort(
    (a, b) => (a.priority || 999) - (b.priority || 999) || (a.providerId || "").localeCompare(b.providerId || "")
  );
}


/**
 * Safe Hot-Reload of Model Registry.
 * Re-scans and validates manifests. If any validation error occurs,
 * existing registryState is kept completely intact and untouched.
 */
export function reloadRegistry(options = {}) {
  return initRegistry({ ...options, forceReload: true });
}

