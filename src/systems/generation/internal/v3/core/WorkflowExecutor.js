import { createHash } from "node:crypto";
import { createLogger } from "#shared";
import { GraphCompiler, getValueByPath } from "./GraphCompiler.js";
import { createJobExecutionContext } from "./JobExecutionContext.js";
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
 * Computes a deterministic SHA-256 signature for a node type, resolved inputs, and optional scope.
 * Including `scope` (`{ runId, userId }`) makes cross-tenant or cross-run collisions structurally impossible.
 *
 * @param {string} nodeType
 * @param {Object} resolvedInputs
 * @param {Object|string|null} [scope=null]
 * @returns {string}
 */
export function computeNodeSignature(nodeType, resolvedInputs, scope = null) {
  const payload = canonicalize({
    type: nodeType,
    inputs: resolvedInputs || {},
    ...(scope ? { scope } : {}),
  });
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
  "CIRCUIT_BREAKER_OPEN",
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
 * WorkflowExecutor (V3 Execution Core)
 *
 * Stateless, database-agnostic parallel wave executor with:
 * - Zero process-global mutable cache state (per-job isolated cache cleared in `finally`)
 * - Scoped SHA-256 signature caching strictly for non-output cacheable nodes (`!OUTPUT_NODE && CACHEABLE !== false`)
 * - Parallel wave execution (`Promise.all`)
 * - Per-node retry with configurable backoff (`retryPolicy`)
 */
export class WorkflowExecutor {
  constructor(registry, { sleepFn = null } = {}) {
    if (!registry) {
      throw new GenerationValidationError("WorkflowExecutor requires a NodeRegistry instance");
    }
    this.registry = registry;
    this.compiler = new GraphCompiler(registry);
    this.sleepFn =
      sleepFn || ((ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()));
  }

  /**
   * Executes a workflow definition inside an isolated per-run `JobExecutionContext`.
   *
   * @param {Object} params
   * @param {Object} params.workflow - Workflow blueprint `{ id, nodes: [...] }`
   * @param {Object} [params.input={}] - Runtime workflow inputs
   * @param {Object|null} [params.jobContext=null] - Optional pre-created `JobExecutionContext`
   * @param {Object} [params.context={}] - Execution context overrides (`userId`, `runId`, node hooks, etc.)
   * @param {Map|null} [params.signatureCache=null] - Optional explicit signature cache override
   * @returns {Promise<Object>}
   */
  async execute({ workflow, input = {}, jobContext = null, context = {}, signatureCache = null } = {}) {
    const normalizedInput = {
      ...input,
      media_id: input.media_id || (Array.isArray(input.serverMediaIds) ? input.serverMediaIds[0] : input.media_id),
      workflow_id: input.workflow_id || input.serverWorkflowId || input.workflow_id,
    };

    const plan = this.compiler.compile(workflow, normalizedInput);
    const nodesMap = new Map(workflow.nodes.map((n) => [n.id, n]));

    const jobCtx =
      jobContext && jobContext.cache instanceof Map
        ? jobContext
        : createJobExecutionContext({
            executionId: context?.executionId || null,
            runId: context?.runId || null,
            jobId: context?.jobId || null,
            userId: context?.userId || null,
            blueprintId: workflow?.id || null,
            workflowId: normalizedInput.workflow_id || context?.workflowId || null,
            billingHoldId: context?.billingHoldId || null,
            mediaId: normalizedInput.media_id || null,
            mediaRole: context?.mediaRole || "output",
            saveType: context?.saveType || "default",
          });

    const ownsCache = !(signatureCache instanceof Map);
    const activeCache = ownsCache ? jobCtx.cache : signatureCache;

    const executionContext = {
      ...context,
      executionId: jobCtx.identity.executionId,
      runId: jobCtx.identity.runId,
      jobId: jobCtx.identity.jobId,
      userId: context?.userId ?? jobCtx.identity.userId,
      workflowId: context?.workflowId ?? jobCtx.identity.workflowId,
      mediaRole: context?.mediaRole ?? jobCtx.resources.mediaRole,
      saveType: context?.saveType ?? jobCtx.resources.saveType,
      jobContext: jobCtx,
    };

    const effectiveRunId = jobCtx.identity.runId || executionContext.runId || null;
    const effectiveUserId = executionContext.userId || null;
    const signatureScope =
      effectiveRunId || effectiveUserId
        ? {
            ...(effectiveRunId ? { runId: effectiveRunId } : {}),
            ...(effectiveUserId ? { userId: effectiveUserId } : {}),
          }
        : null;

    const nodeOutputs = {};
    const terminalOutputs = {};
    const cacheHits = [];

    try {
      for (const wave of plan.waves) {
        await Promise.all(
          wave.map(async (nodeId) => {
            const step = nodesMap.get(nodeId);
            const def = this.registry.get(step.type);
            const resolvedInputs = this.resolveNodeInputs(step, def, normalizedInput, nodeOutputs);

            const isOutputNode = Boolean(def.OUTPUT_NODE);
            const isCacheable = !isOutputNode && def.CACHEABLE !== false;
            const signature = isCacheable
              ? computeNodeSignature(step.type, resolvedInputs, signatureScope)
              : null;

            if (isCacheable && signature && activeCache.has(signature)) {
              const cachedOutput = activeCache.get(signature);
              nodeOutputs[nodeId] = cachedOutput;
              cacheHits.push(nodeId);
              v3ExecutorLogger.debug(
                { nodeId, type: step.type, runId: effectiveRunId, signature: signature.slice(0, 12) },
                `[V3Executor] Cache hit for node "${nodeId}" (${step.type})`
              );
              return;
            }

            const output = await this.executeNodeWithRetry(step, def, resolvedInputs, executionContext);
            nodeOutputs[nodeId] = output;

            if (isCacheable && signature) {
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
        executionId: jobCtx.identity.executionId,
        runId: jobCtx.identity.runId,
        status: "completed",
        nodeOutputs,
        terminalOutputs,
        cacheHits,
        wavesExecuted: plan.waves.length,
        totalEstimatedCredits: plan.totalEstimatedCredits,
        costBreakdown: plan.costBreakdown,
      };
    } finally {
      if (ownsCache) {
        activeCache.clear();
      }
    }
  }

  /**
   * Resolves all inputs for a single node from defaults, static literals, initial inputs, and upstream node outputs.
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
