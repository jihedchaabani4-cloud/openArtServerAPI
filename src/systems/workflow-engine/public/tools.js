/**
 * System 9: Workflow Engine — Public Tools Interface (`#workflow-engine/tools`).
 *
 * Sealed 11-export queue-free Black-Box interface.
 * Zero Redis, BullMQ, HTTP, or database dependencies at module load time.
 */
import { createDefaultV3NodeRegistry } from "../internal/nodes/index.js";
import { GraphCompiler } from "../internal/core/GraphCompiler.js";
import { ExecutionEngine } from "../internal/core/ExecutionEngine.js";
import { configureWorkflowAdapters } from "../internal/adapters.js";
import {
  WorkflowEngineError,
  WorkflowValidationError,
  WorkflowCompilationError,
  WorkflowUpstreamError,
  WorkflowNotFoundError,
  WorkflowSafetyError,
} from "../internal/errors.js";

const DEFAULT_REGISTRY = createDefaultV3NodeRegistry();
const DEFAULT_COMPILER = new GraphCompiler(DEFAULT_REGISTRY);
const DEFAULT_DRY_RUN_ENGINE = new ExecutionEngine({
  registry: DEFAULT_REGISTRY,
  compiler: DEFAULT_COMPILER,
});

/**
 * Pure read-only dry-run contract & DAG validator (never throws).
 *
 * @param {string|Object} workflowOrId
 * @param {Object} [input={}]
 * @returns {{ valid: boolean, workflowId: string|null, missing: string[], errors: Array<Object> }}
 */
export function verifyInput(workflowOrId, input = {}) {
  return DEFAULT_DRY_RUN_ENGINE.verifyInput(workflowOrId, input);
}

/**
 * Pure read-only dry-run cost estimator (fail-closed on invalid node pricing).
 *
 * @param {string|Object} workflowOrId
 * @param {Object} [input={}]
 * @returns {{ totalCredits: number, breakdown: Array<{ nodeId: string, nodeType: string, credits: number }> }}
 */
export function calculateCost(workflowOrId, input = {}) {
  return DEFAULT_DRY_RUN_ENGINE.calculateCost(workflowOrId, input);
}

/**
 * Creates a fresh isolated ExecutionEngine instance sharing the frozen default
 * NodeRegistry and default instance-scoped GraphCompiler (unless a custom registry
 * is supplied, in which case a dedicated GraphCompiler prevents cross-registry cache collisions).
 *
 * @param {Object} [opts={}]
 * @returns {ExecutionEngine}
 */
export function createWorkflowEngine(opts = {}) {
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const hasCustomRegistry = Boolean(safeOpts.registry && safeOpts.registry !== DEFAULT_REGISTRY);
  const registry = hasCustomRegistry ? safeOpts.registry : DEFAULT_REGISTRY;
  const compiler =
    safeOpts.compiler ||
    (hasCustomRegistry ? new GraphCompiler(registry) : DEFAULT_COMPILER);

  return new ExecutionEngine({
    ...safeOpts,
    registry,
    compiler,
  });
}

/**
 * Executes a registered workflow or caller-supplied declarative blueprint immediately
 * in-process inside an isolated per-run JobExecutionContext.
 *
 * @param {string|Object} workflowOrId
 * @param {Object} [input={}]
 * @param {Object} [opts={}]
 * @returns {Promise<Object>}
 */
export async function runWorkflow(workflowOrId, input = {}, opts = {}) {
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const engine = createWorkflowEngine({
    registry: safeOpts.registry,
    compiler: safeOpts.compiler,
    adapters: safeOpts.adapters,
  });
  return engine.runWorkflow(workflowOrId, input, safeOpts);
}

export {
  configureWorkflowAdapters,
  WorkflowEngineError,
  WorkflowValidationError,
  WorkflowCompilationError,
  WorkflowUpstreamError,
  WorkflowNotFoundError,
  WorkflowSafetyError,
};
