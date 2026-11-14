import { GenerationCompilationError } from "../../errors.js";

/**
 * Port type compatibility matrix.
 * Wildcard "ANY" matches anything; STRING is compatible with URL subtypes (IMAGE_URL, VIDEO_URL)
 * so generic nodes like `base.save_media` (expecting `asset_url: STRING`) can accept `IMAGE_URL` or `VIDEO_URL`.
 */
function arePortTypesCompatible(sourceType, targetType) {
  if (!sourceType || !targetType) return false;
  if (sourceType === targetType) return true;
  if (sourceType === "ANY" || targetType === "ANY") return true;

  if (targetType === "STRING" && (sourceType === "IMAGE_URL" || sourceType === "VIDEO_URL")) {
    return true;
  }
  if (sourceType === "STRING" && (targetType === "IMAGE_URL" || targetType === "VIDEO_URL")) {
    return true;
  }
  if (targetType === "FLOAT" && sourceType === "INT") {
    return true;
  }

  return false;
}

/**
 * GraphCompiler (ComfyUI-Style Node Engine V3)
 *
 * Performs:
 * 1. Backward graph pruning starting exclusively from terminal nodes (`OUTPUT_NODE: true`)
 * 2. Cycle detection (DFS visiting set)
 * 3. Port & required input validation (`INPUT_TYPES` vs `RETURN_TYPES`)
 * 4. Topological wave scheduling for parallel execution
 * 5. Deterministic upfront credit cost estimation across active nodes
 */
export class GraphCompiler {
  constructor(registry) {
    if (!registry) {
      throw new GenerationCompilationError("GraphCompiler requires a valid NodeRegistry instance");
    }
    this.registry = registry;
  }

  /**
   * Compiles a workflow definition and computes its pruned execution plan and upfront credit cost.
   *
   * @param {Object} workflowDef
   * @param {Object} [initialInput={}]
   * @returns {Object} Compiled plan with activeNodeIds, waves, totalEstimatedCredits, and costBreakdown
   */
  compile(workflowDef, initialInput = {}) {
    if (!workflowDef || typeof workflowDef !== "object" || !Array.isArray(workflowDef.nodes)) {
      throw new GenerationCompilationError("Invalid workflow definition: must include a nodes array");
    }

    const nodesMap = new Map();
    for (const n of workflowDef.nodes) {
      if (!n || !n.id) {
        throw new GenerationCompilationError("Every workflow node must have a valid string id");
      }
      if (nodesMap.has(n.id)) {
        throw new GenerationCompilationError(`Duplicate node id "${n.id}" in workflow "${workflowDef.id || "unknown"}"`);
      }
      nodesMap.set(n.id, n);
    }

    const activeIds = new Set();
    const visiting = new Set();

    // 1. Backward Pruning from OUTPUT_NODEs + Cycle Detection + Port Type Validation
    const visit = (nodeId) => {
      if (visiting.has(nodeId)) {
        throw new GenerationCompilationError(`Circular dependency detected at node: ${nodeId}`);
      }
      if (activeIds.has(nodeId)) return;

      const step = nodesMap.get(nodeId);
      if (!step) {
        throw new GenerationCompilationError(`Referenced node "${nodeId}" does not exist`);
      }
      const def = this.registry.get(step.type);

      visiting.add(nodeId);

      const stepInputs = step.inputs || {};
      const requiredSpecs = def.INPUT_TYPES?.required || {};
      const optionalSpecs = def.INPUT_TYPES?.optional || {};

      // Validate required inputs are wired or provided
      for (const [reqKey, reqSpec] of Object.entries(requiredSpecs)) {
        const rawVal = stepInputs[reqKey];
        if (rawVal === undefined || rawVal === null) {
          if (reqSpec?.default === undefined) {
            throw new GenerationCompilationError(
              `Node "${nodeId}" (${step.type}) is missing required input "${reqKey}"`
            );
          }
        }
      }

      for (const [inputName, val] of Object.entries(stepInputs)) {
        const inputSpec = requiredSpecs[inputName] || optionalSpecs[inputName];

        if (val && typeof val === "object" && val.fromNode) {
          const upstreamStep = nodesMap.get(val.fromNode);
          if (!upstreamStep) {
            throw new GenerationCompilationError(
              `Node "${nodeId}" references missing node "${val.fromNode}"`
            );
          }
          const upstreamDef = this.registry.get(upstreamStep.type);
          const outType = upstreamDef.RETURN_TYPES?.[val.output];
          if (!outType) {
            throw new GenerationCompilationError(
              `Node "${val.fromNode}" does not produce output "${val.output}"`
            );
          }

          if (inputSpec?.type && !arePortTypesCompatible(outType, inputSpec.type)) {
            throw new GenerationCompilationError(
              `Port type mismatch on node "${nodeId}.${inputName}": expected "${inputSpec.type}", got "${outType}" from "${val.fromNode}.${val.output}"`
            );
          }

          visit(val.fromNode);
        }
      }

      visiting.delete(nodeId);
      activeIds.add(nodeId);
    };

    for (const [nodeId, step] of nodesMap.entries()) {
      const def = this.registry.get(step.type);
      if (def.OUTPUT_NODE) {
        visit(nodeId);
      }
    }

    if (activeIds.size === 0) {
      throw new GenerationCompilationError(`Workflow "${workflowDef.id}" has no OUTPUT_NODE`);
    }

    // 2. Build Parallel Execution Waves (Kahn's topological leveling on pruned subgraph)
    const waves = this.buildExecutionWaves(nodesMap, activeIds);

    // 3. Compute Deterministic Upfront Cost across Active Nodes
    let totalEstimatedCredits = 0;
    const costBreakdown = [];

    for (const nodeId of activeIds) {
      const step = nodesMap.get(nodeId);
      const def = this.registry.get(step.type);
      if (typeof def.estimateCost === "function") {
        const previewInputs = this.resolveStaticAndInitialInputs(step.inputs, initialInput, def);
        const cost = Number(def.estimateCost(previewInputs) || 0);
        if (Number.isNaN(cost) || !Number.isFinite(cost) || cost < 0) {
          throw new GenerationCompilationError(
            `Invalid cost calculation for node "${nodeId}" (${step.type})`
          );
        }
        const roundedCost = Math.ceil(cost);
        if (roundedCost > 0) {
          totalEstimatedCredits += roundedCost;
          costBreakdown.push({ nodeId, type: step.type, credits: roundedCost });
        }
      }
    }

    const activeNodes = Array.from(activeIds).map((id) => nodesMap.get(id));

    return {
      workflowId: workflowDef.id,
      activeNodeIds: Array.from(activeIds),
      activeNodes,
      waves,
      totalEstimatedCredits,
      costBreakdown,
    };
  }

  /**
   * Groups active nodes into topological execution waves where all nodes in a wave
   * have their upstream dependencies satisfied by earlier waves.
   *
   * @param {Map<string, Object>} nodesMap
   * @param {Set<string>} activeIds
   * @returns {Array<Array<string>>}
   */
  buildExecutionWaves(nodesMap, activeIds) {
    const inDegree = new Map();
    const dependents = new Map();

    for (const id of activeIds) {
      inDegree.set(id, 0);
      dependents.set(id, new Set());
    }

    for (const id of activeIds) {
      const step = nodesMap.get(id);
      const deps = new Set();
      for (const val of Object.values(step.inputs || {})) {
        if (val && typeof val === "object" && val.fromNode && activeIds.has(val.fromNode)) {
          deps.add(val.fromNode);
        }
      }
      inDegree.set(id, deps.size);
      for (const depId of deps) {
        dependents.get(depId).add(id);
      }
    }

    const waves = [];
    let currentWave = [];

    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) currentWave.push(id);
    }

    while (currentWave.length > 0) {
      waves.push(currentWave);
      const nextWave = [];
      for (const id of currentWave) {
        for (const depId of dependents.get(id) || []) {
          const nextDeg = inDegree.get(depId) - 1;
          inDegree.set(depId, nextDeg);
          if (nextDeg === 0) {
            nextWave.push(depId);
          }
        }
      }
      currentWave = nextWave;
    }

    return waves;
  }

  /**
   * Resolves static literals, default values, and `{ fromInput }` bindings for upfront cost preview.
   * Supports nested dot-path lookups (e.g. "parameters.duration") via `getValueByPath`.
   *
   * @param {Object} rawInputs
   * @param {Object} initialInput
   * @param {Object} def
   * @returns {Object}
   */
  resolveStaticAndInitialInputs(rawInputs, initialInput, def) {
    const out = {};
    for (const [k, spec] of Object.entries(def.INPUT_TYPES?.required || {})) {
      if (spec.default !== undefined) out[k] = spec.default;
    }
    for (const [k, spec] of Object.entries(def.INPUT_TYPES?.optional || {})) {
      if (spec.default !== undefined) out[k] = spec.default;
    }
    for (const [k, val] of Object.entries(rawInputs || {})) {
      if (val && typeof val === "object" && val.fromInput) {
        const resolved = getValueByPath(initialInput, val.fromInput);
        if (resolved !== undefined) {
          out[k] = resolved;
        } else if (val.default !== undefined) {
          out[k] = val.default;
        }
      } else if (!val || typeof val !== "object" || !val.fromNode) {
        out[k] = val;
      }
    }
    return out;
  }
}

/**
 * Safely resolves a value from an object by key or dot-separated path (e.g. "parameters.duration").
 *
 * @param {Object} obj
 * @param {string} path
 * @returns {*}
 */
export function getValueByPath(obj, path) {
  if (!obj || typeof obj !== "object" || !path || typeof path !== "string") {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, path) && obj[path] !== undefined) {
    return obj[path];
  }
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export default GraphCompiler;

