import { randomUUID } from "node:crypto";
import { createLogger, LogEvents, ErrorSystem, sanitizePublicError, getValueByPath } from "#shared";
import { GraphCompiler } from "./GraphCompiler.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { createJobExecutionContext } from "./JobExecutionContext.js";
import { createDefaultV3NodeRegistry } from "../nodes/index.js";
import { getV3Workflow } from "../workflows/index.js";
import { resolveWorkflowAdapters } from "../adapters.js";
import {
  WorkflowEngineError,
  WorkflowValidationError,
  WorkflowCompilationError,
  WorkflowNotFoundError,
} from "../errors.js";

const engineLogger = createLogger("workflow-engine");

function resolvePlannedInputs(step, def, safeInput) {
  const plannedInputs = {};

  for (const [k, spec] of Object.entries(def.INPUT_TYPES?.required || {})) {
    if (spec.default !== undefined) {
      plannedInputs[k] = spec.default;
    }
  }
  for (const [k, spec] of Object.entries(def.INPUT_TYPES?.optional || {})) {
    if (spec.default !== undefined) {
      plannedInputs[k] = spec.default;
    }
  }

  for (const [inputName, binding] of Object.entries(step.inputs || {})) {
    if (binding && typeof binding === "object" && binding.fromNode) {
      continue;
    }
    if (binding && typeof binding === "object" && binding.fromInput) {
      const val = getValueByPath(safeInput, binding.fromInput);
      if (val !== undefined) {
        plannedInputs[inputName] = val;
      } else if (binding.default !== undefined) {
        plannedInputs[inputName] = binding.default;
      }
    } else {
      plannedInputs[inputName] = binding;
    }
  }

  return plannedInputs;
}

/**
 * ExecutionEngine (Queue-Free Single-Execution Workflow Engine Core)
 *
 * Exposes 3 pure single-execution operations (zero Redis, BullMQ, queues, or domain DB imports):
 * - `verifyInput(workflowOrId, input)`: read-only dry-run contract & DAG validator (never throws).
 * - `calculateCost(workflowOrId, input)`: read-only dry-run cost estimator (fail-closed).
 * - `runWorkflow(workflowOrId, input, opts)`: immediate in-process DAG execution inside an isolated
 *   `JobExecutionContext` with pre-Wave-1 adapter validation and instance/per-run lifecycle hooks.
 */
export class ExecutionEngine {
  constructor({
    registry = null,
    compiler = null,
    executor = null,
    adapters = null,
    onSuccess = null,
    onFailure = null,
  } = {}) {
    this.registry = registry || createDefaultV3NodeRegistry();
    this.compiler = compiler || new GraphCompiler(this.registry);
    this.executor = executor || new WorkflowExecutor(this.registry, this.compiler);
    this.adapters = adapters && typeof adapters === "object" ? { ...adapters } : {};

    this._successHooks = [];
    this._failureHooks = [];
    if (typeof onSuccess === "function") this._successHooks.push(onSuccess);
    if (typeof onFailure === "function") this._failureHooks.push(onFailure);
  }

  onSuccess(handler) {
    if (typeof handler !== "function") return () => {};
    this._successHooks.push(handler);
    return () => {
      const idx = this._successHooks.indexOf(handler);
      if (idx !== -1) this._successHooks.splice(idx, 1);
    };
  }

  onFailure(handler) {
    if (typeof handler !== "function") return () => {};
    this._failureHooks.push(handler);
    return () => {
      const idx = this._failureHooks.indexOf(handler);
      if (idx !== -1) this._failureHooks.splice(idx, 1);
    };
  }

  async #notifySuccess(payload, perRunHook = null) {
    const hooks = typeof perRunHook === "function"
      ? [...this._successHooks, perRunHook]
      : this._successHooks;
    for (const hook of hooks) {
      await Promise.resolve(hook(payload)).catch((hookErr) => {
        engineLogger.warn(
          { runId: payload?.runId, workflowId: payload?.workflowId, err: hookErr?.message },
          "[ExecutionEngine] onSuccess hook encountered an error"
        );
      });
    }
  }

  async #notifyFailure(payload, perRunHook = null) {
    const hooks = typeof perRunHook === "function"
      ? [...this._failureHooks, perRunHook]
      : this._failureHooks;
    for (const hook of hooks) {
      await Promise.resolve(hook(payload)).catch((hookErr) => {
        engineLogger.warn(
          { runId: payload?.runId, workflowId: payload?.workflowId, err: hookErr?.message },
          "[ExecutionEngine] onFailure hook encountered an error"
        );
      });
    }
  }

  resolveWorkflow(workflowOrId) {
    if (workflowOrId && typeof workflowOrId === "object" && workflowOrId.id) {
      return workflowOrId;
    }
    if (typeof workflowOrId === "string" && workflowOrId.trim()) {
      const resolved = getV3Workflow(workflowOrId.trim());
      if (resolved) return resolved;
      throw new WorkflowNotFoundError(`Workflow "${workflowOrId}" not found`, {
        resourceId: workflowOrId,
        code: "USE_CASE_NOT_FOUND",
      });
    }
    throw new WorkflowValidationError("A valid workflow blueprint or workflowId is required");
  }

  verifyInput(workflowOrId, input = {}) {
    let workflow;
    try {
      workflow = this.resolveWorkflow(workflowOrId);
    } catch (err) {
      return {
        valid: false,
        workflowId: typeof workflowOrId === "string" ? workflowOrId : null,
        missing: [],
        errors: [
          {
            code: "USE_CASE_NOT_FOUND",
            message: err?.message || `Workflow "${String(workflowOrId)}" not found`,
          },
        ],
      };
    }

    const safeInput = input && typeof input === "object" ? input : {};
    const missing = [];
    const errors = [];

    const requiredInputs = Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [];
    for (const reqField of requiredInputs) {
      const val = safeInput[reqField];
      if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
        missing.push(reqField);
        errors.push({
          code: "MISSING_REQUIRED_INPUT",
          field: reqField,
          message: `Workflow "${workflow.id}" requires input "${reqField}"`,
        });
      }
    }

    try {
      this.compiler.compile(workflow);
    } catch (compileErr) {
      errors.push({
        code: "COMPILATION_ERROR",
        message: compileErr?.message || String(compileErr),
      });
    }

    return {
      valid: errors.length === 0,
      workflowId: workflow.id,
      missing,
      errors,
    };
  }

  calculateCost(workflowOrId, input = {}) {
    const workflow = this.resolveWorkflow(workflowOrId);
    const plan = this.compiler.compile(workflow);
    const safeInput = input && typeof input === "object" ? input : {};

    let totalCredits = 0;
    const breakdown = [];

    for (const step of plan.activeNodes) {
      const def = this.registry.get(step.type);
      const plannedInputs = resolvePlannedInputs(step, def, safeInput);

      let credits = 0;
      if (typeof def.estimateCost === "function") {
        const rawCredits = def.estimateCost(plannedInputs);
        if (typeof rawCredits !== "number" || !Number.isFinite(rawCredits) || rawCredits < 0) {
          const err = new WorkflowCompilationError(
            `Invalid cost estimate (${String(rawCredits)}) returned by node "${step.id}" (${step.type})`
          );
          err.code = "PRICING_CONFIG_ERROR";
          err.category = "SERVER_FAULT";
          err.statusCode = 500;
          err.retryable = false;
          throw err;
        }
        credits = rawCredits;
      }

      totalCredits += credits;
      breakdown.push({
        nodeId: step.id,
        nodeType: step.type,
        credits,
      });
    }

    return {
      totalCredits,
      breakdown,
    };
  }

  #assertRequiredAdaptersBeforeWave1(plan, safeInput, effectiveContext) {
    for (const step of plan.activeNodes) {
      // If caller overrode execution for this step/type (e.g. unit tests), skip adapter check for it.
      if (
        typeof effectiveContext?.nodeExecutors?.[step.type] === "function" ||
        typeof effectiveContext?.nodeExecutors?.[step.id] === "function"
      ) {
        continue;
      }

      const def = this.registry.get(step.type);
      let required = [];

      if (typeof def.getRequiredAdapters === "function") {
        const plannedInputs = resolvePlannedInputs(step, def, safeInput);
        const dynamicReqs = def.getRequiredAdapters(plannedInputs, effectiveContext, step);
        if (Array.isArray(dynamicReqs)) {
          required = dynamicReqs;
        }
      } else if (Array.isArray(def.REQUIRED_ADAPTERS)) {
        required = def.REQUIRED_ADAPTERS;
      }

      for (const adapterName of required) {
        if (typeof effectiveContext?.[adapterName] !== "function") {
          throw new WorkflowEngineError(
            "WORKFLOW_ADAPTER_NOT_CONFIGURED",
            `Workflow adapter "${adapterName}" required by node "${step.id}" (${step.type}) is not configured`,
            {
              statusCode: 500,
              category: "SERVER_FAULT",
              isInternal: true,
              context: { adapter: adapterName, nodeId: step.id, nodeType: step.type },
            }
          );
        }
      }
    }
  }

  async runWorkflow(
    workflowOrId,
    input = {},
    {
      userId = null,
      executionId = null,
      runId = null,
      jobId = null,
      serverContext = null,
      jobContext = null,
      nodeContext = {},
      adapters = null,
      onSuccess = null,
      onFailure = null,
    } = {}
  ) {
    const workflow = this.resolveWorkflow(workflowOrId);
    const effectiveRunId = runId || executionId || randomUUID();
    const safeInput = input && typeof input === "object" ? input : {};

    const jobCtx =
      jobContext && jobContext.cache instanceof Map
        ? jobContext
        : createJobExecutionContext({
            executionId: effectiveRunId,
            runId: effectiveRunId,
            jobId,
            userId,
            blueprintId: workflow.id,
            workflowId: nodeContext?.workflowId ?? null,
          });

    const effectiveAdaptersAndContext = {
      ...resolveWorkflowAdapters(this.adapters, adapters, nodeContext),
      runId: jobCtx.identity.runId,
      executionId: jobCtx.identity.executionId,
      jobId: jobCtx.identity.jobId,
      userId,
      workflowId: jobCtx.identity.workflowId,
    };

    try {
      jobCtx.markRunning();

      const plan = this.compiler.compile(workflow);
      this.#assertRequiredAdaptersBeforeWave1(plan, safeInput, effectiveAdaptersAndContext);

      const execResult = await this.executor.execute({
        workflow,
        input: safeInput,
        jobContext: jobCtx,
        context: effectiveAdaptersAndContext,
      });

      if (!execResult || execResult.status !== "completed") {
        throw new WorkflowEngineError({
          code: "WORKFLOW_INCOMPLETE",
          message: `Workflow did not complete successfully (status: ${execResult?.status || "unknown"})`,
          statusCode: 500,
          isInternal: true,
        });
      }

      jobCtx.markCompleted();

      const result = {
        ...execResult,
        status: "completed",
        workflowId: workflow.id,
        runId: jobCtx.identity.runId,
        executionId: jobCtx.identity.executionId,
        jobId: jobCtx.identity.jobId,
        terminalOutputs: execResult.terminalOutputs,
        nodeOutputs: execResult.nodeOutputs,
        cacheHits: execResult.cacheHits,
        wavesExecuted: execResult.wavesExecuted,
        state: { ...jobCtx.state },
      };

      await this.#notifySuccess(
        {
          stage: "execute",
          runId: jobCtx.identity.runId,
          workflowId: workflow.id,
          userId,
          input: safeInput,
          serverContext,
          result,
        },
        onSuccess
      );

      return result;
    } catch (err) {
      const report = ErrorSystem.process(err, {
        runId: jobCtx.identity.runId,
        executionId: jobCtx.identity.executionId,
        userId,
        nodeId: err?.nodeId,
      });
      const sanitized = sanitizePublicError(err);
      err.errorReport = {
        ...report,
        sanitized,
      };

      engineLogger.error(
        {
          event: LogEvents.USECASE_FAILED,
          workflowId: workflow?.id,
          runId: jobCtx.identity.runId,
          nodeId: err?.nodeId || null,
          errorCode: sanitized.code,
          errorCategory: sanitized.category,
          err: err.message,
        },
        `[ExecutionEngine] Execution failed for "${workflow?.id}": ${err.message}`
      );

      const failMsg = sanitized.userMessage || report.user?.message || "Workflow execution failed";
      const failCode = sanitized.code || err.code || report.user?.code || "WORKFLOW_EXECUTION_FAILED";

      await this.#notifyFailure(
        {
          stage: "execute",
          runId: jobCtx.identity.runId,
          workflowId: workflow?.id,
          userId,
          input: safeInput,
          serverContext,
          nodeId: err?.nodeId || null,
          errorCode: failCode,
          errorMessage: failMsg,
          error: err,
          errorReport: err.errorReport,
        },
        onFailure
      );

      jobCtx.markFailed(err);
      throw err;
    } finally {
      jobCtx.dispose();
    }
  }
}

export default ExecutionEngine;
