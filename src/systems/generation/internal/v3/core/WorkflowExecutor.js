import { createHash } from "node:crypto";
import { createLogger } from "#shared";
import { GraphCompiler, getValueByPath } from "./GraphCompiler.js";
import { GenerationValidationError } from "../../errors.js";

const v3ExecutorLogger = createLogger("v3-executor");

/**
 * Deterministically serializes a value for SHA-256 signature calculation.
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
  return "{" + entries.join(",") + "}";
}

/**
 * Computes a deterministic SHA-256 signature for a node type and its resolved inputs.
 *
 * @param {string} nodeType
 * @param {Object} resolvedInputs
 * @returns {string}
 */
export function computeNodeSignature(nodeType, resolvedInputs) {
  const payload = canonicalize({ type: nodeType, inputs: resolvedInputs || {} });
  return createHash("sha256").update(payload).digest("hex");
}

const NON_RETRYABLE_CATEGORIES = new Set([
  "USER_FAULT",
  "CONTENT_SAFETY_VIOLATION",
  "HOLD_EXPIRED",
  "SERVER_FAULT",
]);

const NON_RETRYABLE_CODES = new Set([
  "CONTENT_SAFETY_VIOLATION",
  "PROMPT_VIOLATION",
  "PROVIDER_CONTENT_POLICY_ERROR",
  "SAFETY_CHECK_FAILED",
  "HOLD_EXPIRED",
  "GENERATION_VALIDATION_ERROR",
  "GENERATION_NOT_FOUND",
  "OWNERSHIP_VERIFICATION_FAILED",
  "TARGET_VERIFICATION_FAILED",
]);

/**
 * Determines whether an error is retryable according to the node's retryPolicy.
 *
 * @param {Error} err
 * @param {Object} retryPolicy
 * @returns {boolean}
 */
export function isErrorRetryable(err, retryPolicy) {
  if (!retryPolicy || (retryPolicy.maxAttempts ?? 1) <= 1) return false;
  if (err?.retryable === false) return false;
  if (err?.is_safe === false) return false;

  const code = String(err?.code || err?.errorCode || "").toUpperCase();
  if (NON_RETRYABLE_CODES.has(code)) return false;

  const category = String(err?.category || "").toUpperCase();
  const safetyCategory = String(err?.safetyCategory || "").toUpperCase();
  if (NON_RETRYABLE_CATEGORIES.has(category) || NON_RETRYABLE_CATEGORIES.has(safetyCategory)) {
    return false;
  }

  if (err?.retryable === true) return true;

  const allowedCategories = Array.isArray(retryPolicy.retryableCategories)
    ? retryPolicy.retryableCategories
    : ["UPSTREAM_FAULT", "RATE_LIMIT"];

  if (category && allowedCategories.includes(category)) {
    return true;
  }

  if (
    code.includes("RATE_LIMIT") ||
    code.includes("TIMEOUT") ||
    code.includes("TRANSIENT") ||
    code.includes("UPSTREAM")
  ) {
    return true;
  }

  return false;
}

/**
 * WorkflowExecutor (ComfyUI-Style Node Engine V3)
 *
 * 100% database-agnostic parallel wave executor with:
 * - Parallel wave execution (`Promise.all`)
 * - SHA-256 signature caching for non-output nodes (`OUTPUT_NODE: false`)
 * - Per-node retry with configurable backoff (`retryPolicy`)
 */
export class WorkflowExecutor {
  constructor(registry, { cache = null, sleepFn = null } = {}) {
    if (!registry) {
      throw new GenerationValidationError("WorkflowExecutor requires a NodeRegistry instance");
    }
    this.registry = registry;
    this.compiler = new GraphCompiler(registry);
    this.cache = cache instanceof Map ? cache : new Map();
    this.sleepFn =
      sleepFn || ((ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()));
  }

  /**
   * Executes a workflow definition or pre-compiled plan.
   *
   * @param {Object} params
   * @param {Object} params.workflow - Workflow blueprint `{ id, nodes: [...] }`
   * @param {Object} [params.input={}] - Runtime workflow inputs
   * @param {Object} [params.context={}] - Execution context `{ runId, userId, traceId, ... }`
   * @param {Map} [params.signatureCache] - Optional signature cache override
   * @returns {Promise<{ workflowId: string, status: string, nodeOutputs: Object, terminalOutputs: Object, cacheHits: string[], wavesExecuted: number }>}
   */
  async execute({ workflow, input = {}, context = {}, signatureCache = null } = {}) {
    const normalizedInput = {
      ...input,
      media_id: input.media_id || (Array.isArray(input.serverMediaIds) ? input.serverMediaIds[0] : input.media_id),
      workflow_id: input.workflow_id || input.serverWorkflowId || input.workflow_id,
    };
    const plan = this.compiler.compile(workflow, normalizedInput);
    const nodesMap = new Map(workflow.nodes.map((n) => [n.id, n]));
    const activeCache = signatureCache instanceof Map ? signatureCache : this.cache;

    const nodeOutputs = {};
    const terminalOutputs = {};
    const cacheHits = [];

    for (const wave of plan.waves) {
      await Promise.all(
        wave.map(async (nodeId) => {
          const step = nodesMap.get(nodeId);
          const def = this.registry.get(step.type);
          const resolvedInputs = this.resolveNodeInputs(step, def, normalizedInput, nodeOutputs);

          // Check SHA-256 signature cache for non-terminal nodes
          const isOutputNode = Boolean(def.OUTPUT_NODE);
          const signature = !isOutputNode ? computeNodeSignature(step.type, resolvedInputs) : null;

          if (!isOutputNode && signature && activeCache.has(signature)) {
            const cachedOutput = activeCache.get(signature);
            nodeOutputs[nodeId] = cachedOutput;
            cacheHits.push(nodeId);
            v3ExecutorLogger.debug(
              { nodeId, type: step.type, signature: signature.slice(0, 12) },
              `[V3Executor] Cache hit for node "${nodeId}" (${step.type})`
            );
            return;
          }

          const output = await this.executeNodeWithRetry(step, def, resolvedInputs, context);
          nodeOutputs[nodeId] = output;

          if (!isOutputNode && signature) {
            activeCache.set(signature, output);
          }

          if (isOutputNode) {
            terminalOutputs[nodeId] = output;
          }
        })
      );
    }

    return {
      workflowId: workflow.id,
      status: "completed",
      nodeOutputs,
      terminalOutputs,
      cacheHits,
      wavesExecuted: plan.waves.length,
      totalEstimatedCredits: plan.totalEstimatedCredits,
      costBreakdown: plan.costBreakdown,
    };
  }

  /**
   * Resolves all inputs for a single node from defaults, static literals, initial inputs, and upstream node outputs.
   *
   * @param {Object} step
   * @param {Object} def
   * @param {Object} initialInput
   * @param {Object} nodeOutputs
   * @returns {Object}
   */
  resolveNodeInputs(step, def, initialInput, nodeOutputs) {
    const resolved = {};

    for (const [k, spec] of Object.entries(def.INPUT_TYPES?.required || {})) {
      if (spec.default !== undefined) {
        resolved[k] = spec.default;
      }
    }
    for (const [k, spec] of Object.entries(def.INPUT_TYPES?.optional || {})) {
      if (spec.default !== undefined) {
        resolved[k] = spec.default;
      }
    }

    for (const [inputName, binding] of Object.entries(step.inputs || {})) {
      if (binding && typeof binding === "object" && binding.fromNode) {
        const upstreamOut = nodeOutputs[binding.fromNode];
        if (!upstreamOut || !(binding.output in upstreamOut)) {
          throw new GenerationValidationError(
            `Node "${step.id}" could not resolve output "${binding.output}" from upstream node "${binding.fromNode}"`
          );
        }
        resolved[inputName] = upstreamOut[binding.output];
      } else if (binding && typeof binding === "object" && binding.fromInput) {
        const val = getValueByPath(initialInput, binding.fromInput);
        if (val !== undefined) {
          resolved[inputName] = val;
        } else if (binding.default !== undefined) {
          resolved[inputName] = binding.default;
        }
      } else {
        resolved[inputName] = binding;
      }
    }

    // Validate required inputs at runtime after resolution
    for (const reqKey of Object.keys(def.INPUT_TYPES?.required || {})) {
      if (resolved[reqKey] === undefined || resolved[reqKey] === null) {
        throw new GenerationValidationError(
          `Node "${step.id}" (${step.type}) missing required input "${reqKey}" at runtime`,
          { field: reqKey }
        );
      }
    }

    return resolved;
  }

  /**
   * Executes a single node with its declared `retryPolicy`.
   *
   * @param {Object} step
   * @param {Object} def
   * @param {Object} resolvedInputs
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async executeNodeWithRetry(step, def, resolvedInputs, context) {
    const policy = def.retryPolicy || { maxAttempts: 1, backoffMs: 0 };
    const maxAttempts = Math.max(1, Number(policy.maxAttempts || 1));
    const backoffMs = Math.max(0, Number(policy.backoffMs || 0));

    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const nodeCtx = {
          ...context,
          nodeId: step.id,
          nodeType: step.type,
          attempt,
        };

        const overrideFn =
          context?.nodeExecutors?.[step.type] ||
          context?.nodeExecutors?.[step.id];

        if (typeof overrideFn === "function") {
          const out = await overrideFn(resolvedInputs, nodeCtx);
          return out || {};
        }

        const out = await def.execute(resolvedInputs, nodeCtx);
        return out || {};
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts && isErrorRetryable(err, policy)) {
          const delay = backoffMs * attempt;
          v3ExecutorLogger.warn(
            { nodeId: step.id, type: step.type, attempt, maxAttempts, delay, err: err.message },
            `[V3Executor] Node "${step.id}" (${step.type}) failed on attempt ${attempt}/${maxAttempts}. Retrying...`
          );
          await this.sleepFn(delay);
          continue;
        }
        if (lastErr && typeof lastErr === "object" && !lastErr.nodeId) {
          lastErr.nodeId = step.id;
        }
        throw lastErr;
      }
    }

    throw lastErr;
  }
}

export default WorkflowExecutor;
