import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  UnknownProviderReferenceError,
  UnknownOperationReferenceError,
  UnknownCanonicalParameterError,
  DuplicateBindingError,
  UnknownModelFamilyError,
  UnknownOperationError,
  PriorityConflictError,
  MissingOutputMapError
} from "../errors/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MODELS_ROOT = path.resolve(__dirname, "..");

let registryState = {
  isInitialized: false,
  models: new Map(),
  providers: new Map(),
  sharedParams: new Map(),
  bindings: new Map(),
  bindingIndex: new Map(), // key: `${modelId}:${operation}` -> Array<Binding> sorted by priority
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
  const bindings = new Map();
  const bindingIndex = new Map();

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
      models.set(modelDef.id, modelDef);

      // Load nested bindings
      const bindingsDir = path.join(manifestsDir, modelId, "bindings");
      if (fs.existsSync(bindingsDir)) {
        const bindingFiles = fs.readdirSync(bindingsDir).filter((f) => f.endsWith(".json"));
        for (const file of bindingFiles) {
          const bindingPath = path.join(bindingsDir, file);
          const bindingDef = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
          bindingDef.modelId = bindingDef.modelId || modelDef.id;
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

      if (b.parameterMap) {
        for (const canonicalKey of Object.keys(b.parameterMap)) {
          const isDeclaredInModel = Object.prototype.hasOwnProperty.call(canonicalInputs, canonicalKey);
          const isDeclaredInShared = Object.prototype.hasOwnProperty.call(domainShared, canonicalKey);

          if (!isDeclaredInModel && !isDeclaredInShared) {
            throw new UnknownCanonicalParameterError(mId, op, canonicalKey);
          }
        }
      }

      // Validation Rule 6: Mandatory outputMap check
      if (!b.outputMap || typeof b.outputMap !== "object" || Object.keys(b.outputMap).length === 0) {
        throw new MissingOutputMapError(mId, op, b.providerId);
      }
    }
  }

  registryState = {
    isInitialized: true,
    models,
    providers,
    sharedParams,
    bindings,
    bindingIndex,
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
  const { models } = getRegistry();
  let model = models.get(modelId);
  if (!model && typeof modelId === "string") {
    model = models.get(modelId.replace(/-/g, "_")) || models.get(modelId.replace(/_/g, "-"));
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

export function getBindings(modelId, operation) {
  const { bindingIndex, models } = getRegistry();
  const model =
    models.get(modelId) ||
    models.get(typeof modelId === "string" ? modelId.replace(/-/g, "_") : null) ||
    models.get(typeof modelId === "string" ? modelId.replace(/_/g, "-") : null);

  if (!model) {
    throw new UnknownModelFamilyError(modelId);
  }
  if (!model.operations || !model.operations[operation]) {
    throw new UnknownOperationError(model.id, operation);
  }
  const indexKey = `${model.id}:${operation}`;
  return bindingIndex.get(indexKey) || [];
}

export function getBinding(modelId, operation, providerId) {
  const { bindings, models } = getRegistry();
  const model =
    models.get(modelId) ||
    models.get(typeof modelId === "string" ? modelId.replace(/-/g, "_") : null) ||
    models.get(typeof modelId === "string" ? modelId.replace(/_/g, "-") : null);

  const actualId = model ? model.id : modelId;
  const key = `${actualId}:${operation}:${providerId}`;
  return bindings.get(key) || null;
}

export function resetRegistry() {
  registryState = {
    isInitialized: false,
    models: new Map(),
    providers: new Map(),
    sharedParams: new Map(),
    bindings: new Map(),
    bindingIndex: new Map(),
  };
}

/**
 * Safe Hot-Reload of Model Registry.
 * Re-scans and validates manifests. If any validation error occurs,
 * existing registryState is kept completely intact and untouched.
 */
export function reloadRegistry(options = {}) {
  return initRegistry({ ...options, forceReload: true });
}

