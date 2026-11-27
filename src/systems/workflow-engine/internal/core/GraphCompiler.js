import { getValueByPath } from "#shared";
import { WorkflowCompilationError } from "../errors.js";

export { getValueByPath };

/**
 * Port type compatibility matrix.
 * Wildcard "ANY" matches anything; STRING is compatible with URL subtypes (IMAGE_URL, VIDEO_URL).
 * Single `IMAGE_URL` outputs are compatible with `ARRAY` inputs.
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
  if (targetType === "ARRAY" && sourceType === "IMAGE_URL") {
    return true;
  }
  if (targetType === "FLOAT" && sourceType === "INT") {
    return true;
  }

  return false;
}

/**
 * GraphCompiler (Standalone Workflow Engine Core)
 *
 * Performs:
 * 1. Backward graph pruning starting exclusively from terminal nodes (`OUTPUT_NODE: true`)
 * 2. Cycle detection (DFS visiting set)
 * 3. Port & required input validation (`INPUT_TYPES` vs `RETURN_TYPES`)
 * 4. Topological wave scheduling for parallel execution (Kahn's algorithm)
 * 5. Instance-scoped O(1) WeakMap Compiled Plan Caching for frozen blueprints
 *    (isolated per GraphCompiler/NodeRegistry so custom registries never poison default plans)
 */
export class GraphCompiler {
  constructor(registry) {
    if (!registry) {
      throw new WorkflowCompilationError("GraphCompiler requires a valid NodeRegistry instance");
    }
    this.registry = registry;
    this._planCache = new WeakMap();
  }

  compile(workflowDef) {
    if (!workflowDef || typeof workflowDef !== "object" || !Array.isArray(workflowDef.nodes)) {
      throw new WorkflowCompilationError("Invalid workflow definition: must include a nodes array");
    }

    if (Object.isFrozen(workflowDef) && this._planCache.has(workflowDef)) {
      return this._planCache.get(workflowDef);
    }

    const nodesMap = new Map();
    for (const n of workflowDef.nodes) {
      if (!n || !n.id) {
        throw new WorkflowCompilationError("Every workflow node must have a valid string id");
      }
      if (nodesMap.has(n.id)) {
        throw new WorkflowCompilationError(`Duplicate node id "${n.id}" in workflow "${workflowDef.id || "unknown"}"`);
      }
      nodesMap.set(n.id, n);
    }

    const activeIds = new Set();
    const visiting = new Set();

    const visit = (nodeId) => {
      if (visiting.has(nodeId)) {
        throw new WorkflowCompilationError(`Circular dependency detected at node: ${nodeId}`);
      }
      if (activeIds.has(nodeId)) return;

      const step = nodesMap.get(nodeId);
      if (!step) {
        throw new WorkflowCompilationError(`Referenced node "${nodeId}" does not exist`);
      }
      const def = this.registry.get(step.type);

      visiting.add(nodeId);

      const stepInputs = step.inputs || {};
      const requiredSpecs = def.INPUT_TYPES?.required || {};
      const optionalSpecs = def.INPUT_TYPES?.optional || {};

      for (const [reqKey, reqSpec] of Object.entries(requiredSpecs)) {
        const rawVal = stepInputs[reqKey];
        if (rawVal === undefined || rawVal === null) {
          if (reqSpec?.default === undefined) {
            throw new WorkflowCompilationError(
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
            throw new WorkflowCompilationError(
              `Node "${nodeId}" references missing node "${val.fromNode}"`
            );
          }
          const upstreamDef = this.registry.get(upstreamStep.type);
          const outType = upstreamDef.RETURN_TYPES?.[val.output];
          if (!outType) {
            throw new WorkflowCompilationError(
              `Node "${val.fromNode}" does not produce output "${val.output}"`
            );
          }

          if (inputSpec?.type && !arePortTypesCompatible(outType, inputSpec.type)) {
            throw new WorkflowCompilationError(
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
      throw new WorkflowCompilationError(`Workflow "${workflowDef.id}" has no OUTPUT_NODE`);
    }

    const waves = this.buildExecutionWaves(nodesMap, activeIds);
    const activeNodes = Array.from(activeIds).map((id) => nodesMap.get(id));

    const plan = {
      workflowId: workflowDef.id,
      activeNodeIds: Array.from(activeIds),
      activeNodes,
      waves,
    };

    if (Object.isFrozen(workflowDef)) {
      this._planCache.set(workflowDef, plan);
    }

    return plan;
  }

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
}

export default GraphCompiler;
