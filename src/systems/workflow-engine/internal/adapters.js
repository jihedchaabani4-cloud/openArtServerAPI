/**
 * Composition-Root Adapter Seam for System 9: Workflow Engine.
 *
 * Keeps workflow-engine strictly zero-DB and zero-Redis at module load time
 * (depending statically only on #shared and #models/tools) while allowing peer
 * domain operations (Characters, Elements, Media, Identity) to be injected once
 * at startup or overridden per engine/run for isolated execution and testing.
 */
import { envConfig } from "#shared";
import { WorkflowEngineError, WorkflowValidationError } from "./errors.js";

export const WORKFLOW_ADAPTER_KEYS = Object.freeze([
  "getCharacterPromptContext",
  "getElementPromptContext",
  "getMediaById",
  "getMediaUrls",
  "getWorkflowPrimaryMedia",
  "completeMedia",
  "persistExternalMedia",
  "assertOwns",
  "assertOwnsAny",
]);

const ALLOWED_KEYS_SET = new Set(WORKFLOW_ADAPTER_KEYS);

let _configuredAdapters = Object.freeze({});
let _locked = false;

/**
 * Registers default domain adapters for workflow Base Nodes.
 * Locked against reassignment outside test environments to prevent runtime tampering.
 *
 * @param {Object} adapters
 * @returns {Readonly<Object>}
 */
export function configureWorkflowAdapters(adapters = {}) {
  if (!adapters || typeof adapters !== "object") {
    throw new WorkflowValidationError("configureWorkflowAdapters requires an adapters object", {
      field: "adapters",
    });
  }

  if (_locked && !envConfig.isTest) {
    throw new WorkflowEngineError(
      "WORKFLOW_ADAPTERS_LOCKED",
      "Workflow adapters are already configured and locked outside test mode",
      { statusCode: 403, category: "USER_FAULT" }
    );
  }

  const next = { ..._configuredAdapters };
  for (const [key, fn] of Object.entries(adapters)) {
    if (!ALLOWED_KEYS_SET.has(key)) {
      throw new WorkflowValidationError(`Unknown workflow adapter key "${key}"`, {
        field: key,
      });
    }
    if (fn !== undefined && fn !== null && typeof fn !== "function") {
      throw new WorkflowValidationError(`Workflow adapter "${key}" must be a function`, {
        field: key,
      });
    }
    if (typeof fn === "function") {
      next[key] = fn;
    }
  }

  _configuredAdapters = Object.freeze(next);
  if (!envConfig.isTest) {
    _locked = true;
  }
  return _configuredAdapters;
}

export function getWorkflowAdapters() {
  return _configuredAdapters;
}

/**
 * Resolves effective adapters with deterministic precedence:
 *   nodeContext > runAdapters > engineAdapters > global defaults
 */
export function resolveWorkflowAdapters(engineAdapters = null, runAdapters = null, nodeContext = null) {
  return {
    ..._configuredAdapters,
    ...(engineAdapters && typeof engineAdapters === "object" ? engineAdapters : {}),
    ...(runAdapters && typeof runAdapters === "object" ? runAdapters : {}),
    ...(nodeContext && typeof nodeContext === "object" ? nodeContext : {}),
  };
}

/**
 * Fetches a required adapter function from execution context or configured defaults,
 * failing closed with HTTP 500 `WORKFLOW_ADAPTER_NOT_CONFIGURED` if absent.
 *
 * @param {string} name
 * @param {Object} [context={}]
 * @returns {Function}
 */
export function requireAdapter(name, context = {}) {
  const fromContext = context && typeof context === "object" ? context[name] : null;
  if (typeof fromContext === "function") {
    return fromContext;
  }
  const fromGlobal = _configuredAdapters[name];
  if (typeof fromGlobal === "function") {
    return fromGlobal;
  }
  throw new WorkflowEngineError(
    "WORKFLOW_ADAPTER_NOT_CONFIGURED",
    `Workflow adapter "${name}" is not configured. Call configureWorkflowAdapters() at startup or provide "${name}" in engine/run adapters.`,
    { statusCode: 500, category: "SERVER_FAULT", isInternal: true, context: { adapter: name } }
  );
}

export function resetWorkflowAdaptersForTest() {
  if (!envConfig.isTest) {
    throw new WorkflowEngineError(
      "WORKFLOW_ADAPTERS_LOCKED",
      "resetWorkflowAdaptersForTest is only permitted in test mode",
      { statusCode: 403, category: "USER_FAULT" }
    );
  }
  _configuredAdapters = Object.freeze({});
  _locked = false;
}

export default {
  WORKFLOW_ADAPTER_KEYS,
  configureWorkflowAdapters,
  getWorkflowAdapters,
  resolveWorkflowAdapters,
  requireAdapter,
  resetWorkflowAdaptersForTest,
};
