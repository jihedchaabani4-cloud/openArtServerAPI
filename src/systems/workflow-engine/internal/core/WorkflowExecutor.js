import { createHash } from "node:crypto";
import { createLogger, getValueByPath } from "#shared";
import { GraphCompiler } from "./GraphCompiler.js";
import { createJobExecutionContext } from "./JobExecutionContext.js";
import { WorkflowValidationError } from "../errors.js";

const executorLogger = createLogger("workflow-executor");

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

export function computeNodeSignature(nodeType, resolvedInputs, scope = null) {
  const payload = canonicalize({
    type: nodeType,
    inputs: resolvedInputs || {},
    ...(scope ? { scope } : {}),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * WorkflowExecutor (Standalone Workflow Engine Core)
 *
 * Stateless, domain-agnostic, fail-fast parallel wave executor:
 * - Reuses the shared `GraphCompiler` passed by `ExecutionEngine` (O(1) plan cache)
 * - Runs waves sequentially; nodes within each wave execute concurrently via `Promise.all`
 * - Zero automatic retries (single-attempt fail-fast so side-effect nodes never duplicate)
 * - Scoped per-run SHA-256 cache for cacheable non-output nodes, cleared in `finally`
 */
export class WorkflowExecutor {
  constructor(registry, compilerOrOptions = null) {
    if (!registry) {
      throw new WorkflowValidationError("WorkflowExecutor requires a NodeRegistry instance");
    }
    this.registry = registry;
    const explicitCompiler =
      compilerOrOptions && typeof compilerOrOptions.compile === "function"
        ? compilerOrOptions
        : compilerOrOptions?.compiler && typeof compilerOrOptions.compiler.compile === "function"
          ? compilerOrOptions.compiler
          : null;
    this.compiler = explicitCompiler || new GraphCompiler(registry);
  }

  async execute({ workflow, input = {}, jobContext = null, context = {}, signatureCache = null } = {}) {
    const plan = this.compiler.compile(workflow);
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
            workflowId: context?.workflowId ?? null,
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
            const resolvedInputs = this.resolveNodeInputs(step, def, input, nodeOutputs);

            const isOutputNode = Boolean(def.OUTPUT_NODE);
            const isCacheable = !isOutputNode && def.CACHEABLE !== false;
            const signature = isCacheable
              ? computeNodeSignature(step.type, resolvedInputs, signatureScope)
              : null;

            if (isCacheable && signature && activeCache.has(signature)) {
              const cachedOutput = activeCache.get(signature);
              nodeOutputs[nodeId] = cachedOutput;
              cacheHits.push(nodeId);
              executorLogger.debug(
                { nodeId, type: step.type, runId: effectiveRunId, signature: signature.slice(0, 12) },
                `[WorkflowExecutor] Cache hit for node "${nodeId}" (${step.type})`
              );
              return;
            }

            const output = await this.executeNode(step, def, resolvedInputs, executionContext);
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
      };
    } finally {
      if (ownsCache) {
        activeCache.clear();
      }
    }
  }

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
          throw new WorkflowValidationError(
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
        throw new WorkflowValidationError(
          `Node "${step.id}" (${step.type}) missing required input "${reqKey}" at runtime`,
          { field: reqKey }
        );
      }
    }

    return resolved;
  }

  async executeNode(step, def, resolvedInputs, context) {
    try {
      const nodeCtx = {
        ...context,
        nodeId: step.id,
        nodeType: step.type,
        attempt: 1,
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
      if (err && typeof err === "object" && !err.nodeId) {
        err.nodeId = step.id;
      }
      throw err;
    }
  }
}

export default WorkflowExecutor;
