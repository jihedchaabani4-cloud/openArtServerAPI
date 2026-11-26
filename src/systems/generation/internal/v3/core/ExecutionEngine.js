import { randomUUID } from "node:crypto";
import { createLogger, LogEvents, ErrorSystem } from "#shared";
import { jobQueueService as defaultJobQueueService } from "../../services/jobQueueService.js";
import { GraphCompiler, getValueByPath } from "./GraphCompiler.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { createJobExecutionContext } from "./JobExecutionContext.js";
import { createDefaultV3NodeRegistry } from "../nodes/index.js";
import { getV3Workflow } from "../workflows/index.js";
import {
  GenerationError,
  GenerationValidationError,
  GenerationCompilationError,
  GenerationQueueDispatchError,
  sanitizeClientError,
} from "../../errors.js";

const engineLogger = createLogger("execution-engine");

function mergeServerContext(input = {}, serverContext = null) {
  if (!serverContext || typeof serverContext !== "object") return { ...input };
  return {
    ...serverContext,
    ...input,
  };
}

/**
 * ExecutionEngine (Universal Black-Box V3 Core)
 *
 * Minimal 3-tool domain-agnostic DAG engine (zero domain, storage, or wallet coupling):
 * - `verifyInput(workflowOrId, input)`: pure read-only dry-run contract & DAG validator (never throws).
 * - `calculateCost(workflowOrId, input)`: pure read-only dry-run cost estimator (fail-closed).
 * - `runWorkflow(workflowOrId, input, opts)`: single unified execution entrypoint supporting both
 *   asynchronous queue dispatch (`async: true`) and in-process DAG execution (`async: false`).
 * - External domain concerns attach via lifecycle hooks (`onSuccess` / `onFailure`).
 */
export class ExecutionEngine {
  constructor({
    registry = null,
    compiler = null,
    executor = null,
    jobQueueService = undefined,
    onSuccess = null,
    onFailure = null,
  } = {}) {
    this.registry = registry || createDefaultV3NodeRegistry();
    this.compiler = compiler || new GraphCompiler(this.registry);
    this.executor = executor || new WorkflowExecutor(this.registry);

    this.jobQueueService = jobQueueService === undefined ? defaultJobQueueService : jobQueueService;

    this._successHooks = [];
    this._failureHooks = [];
    if (typeof onSuccess === "function") this._successHooks.push(onSuccess);
    if (typeof onFailure === "function") this._failureHooks.push(onFailure);
  }

  /**
   * Registers an external lifecycle hook invoked when a workflow run completes successfully.
   * Returns an unsubscribe function.
   */
  onSuccess(handler) {
    if (typeof handler !== "function") return () => {};
    this._successHooks.push(handler);
    return () => {
      const idx = this._successHooks.indexOf(handler);
      if (idx !== -1) this._successHooks.splice(idx, 1);
    };
  }

  /**
   * Registers an external lifecycle hook invoked when a workflow run fails (dispatch, execution, or crash).
   * Returns an unsubscribe function.
   */
  onFailure(handler) {
    if (typeof handler !== "function") return () => {};
    this._failureHooks.push(handler);
    return () => {
      const idx = this._failureHooks.indexOf(handler);
      if (idx !== -1) this._failureHooks.splice(idx, 1);
    };
  }

  async notifySuccess(payload) {
    for (const hook of this._successHooks) {
      await Promise.resolve(hook(payload)).catch((hookErr) => {
        engineLogger.warn(
          { runId: payload?.runId, workflowId: payload?.workflowId, err: hookErr?.message },
          "[ExecutionEngine] onSuccess hook encountered an error"
        );
      });
    }
  }

  async notifyFailure(payload) {
    for (const hook of this._failureHooks) {
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
      const err = new GenerationValidationError(`Workflow "${workflowOrId}" not found`);
      err.code = "USE_CASE_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }
    throw new GenerationValidationError("A valid V3 workflow blueprint or workflowId/useCaseId is required");
  }

  /**
   * Tool 1: Pure read-only dry-run validator (zero DB/Redis side effects, never throws).
   * Resolves workflow, checks `requiredInputs`, and validates DAG compilation.
   *
   * @param {string|Object} workflowOrId
   * @param {Object} [input={}]
   * @returns {{ valid: boolean, workflowId: string|null, missing: string[], errors: Array<{ code: string, field?: string, message: string }> }}
   */
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

  /**
   * Tool 2: Pure read-only dry-run cost estimator (zero DB/Redis/wallet side effects).
   * Compiles the DAG (O(1) cached for frozen workflows), resolves static/input planned values,
   * and sums per-node `estimateCost(plannedInputs)` fail-closed.
   *
   * @param {string|Object} workflowOrId
   * @param {Object} [input={}]
   * @returns {{ totalCredits: number, breakdown: Array<{ nodeId: string, nodeType: string, credits: number }> }}
   */
  calculateCost(workflowOrId, input = {}) {
    const workflow = this.resolveWorkflow(workflowOrId);
    const plan = this.compiler.compile(workflow);
    const safeInput = input && typeof input === "object" ? input : {};

    let totalCredits = 0;
    const breakdown = [];

    for (const step of plan.activeNodes) {
      const def = this.registry.get(step.type);
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

      let credits = 0;
      if (typeof def.estimateCost === "function") {
        const rawCredits = def.estimateCost(plannedInputs);
        if (typeof rawCredits !== "number" || !Number.isFinite(rawCredits) || rawCredits < 0) {
          const err = new GenerationCompilationError(
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

  /**
   * Tool 3: Unified workflow execution entrypoint.
   * - `async !== false` (default): validates via `verifyInput`, enqueues job, returns queued handle.
   * - `async === false`: executes compiled DAG in-process inside an isolated `JobExecutionContext`,
   *   sanitizes errors, fires `onSuccess` / `onFailure` hooks, and disposes context in `finally`.
   *
   * @param {string|Object} workflowOrId
   * @param {Object} [input={}]
   * @param {Object} [opts={}]
   * @returns {Promise<Object>}
   */
  async runWorkflow(
    workflowOrId,
    input = {},
    {
      async: isAsync = true,
      userId = null,
      executionId = null,
      runId = null,
      jobId = null,
      idempotencyKey = null,
      traceId = null,
      serverContext = null,
      jobContext = null,
      nodeContext = {},
    } = {}
  ) {
    if (isAsync !== false) {
      const mergedInput = mergeServerContext(input, serverContext);
      const validation = this.verifyInput(workflowOrId, mergedInput);

      if (!validation.valid) {
        const firstErr = validation.errors[0];
        if (firstErr?.code === "USE_CASE_NOT_FOUND") {
          const err = new GenerationValidationError(firstErr.message);
          err.code = "USE_CASE_NOT_FOUND";
          err.statusCode = 404;
          throw err;
        }
        if (firstErr?.code === "MISSING_REQUIRED_INPUT") {
          throw new GenerationValidationError(
            `Workflow "${validation.workflowId}" requires input "${firstErr.field}" before launch`,
            { field: firstErr.field }
          );
        }
        throw new GenerationCompilationError(firstErr?.message || "Workflow compilation failed");
      }

      const workflow = this.resolveWorkflow(workflowOrId);
      const resolvedRunId = runId || executionId || randomUUID();
      const effectiveTraceId = traceId || resolvedRunId;
      const referenceId = idempotencyKey || `exec:${workflow.id}:${userId || "anon"}:${resolvedRunId}`;
      const opaqueServerContext = serverContext ?? null;

      if (!this.jobQueueService || typeof this.jobQueueService.addUseCaseJob !== "function") {
        const err = new GenerationQueueDispatchError("Job queue service is not configured for ExecutionEngine");
        await this.notifyFailure({
          stage: "launch",
          runId: resolvedRunId,
          workflowId: workflow.id,
          userId,
          input: mergedInput,
          serverContext: opaqueServerContext,
          errorCode: "QUEUE_NOT_CONFIGURED",
          errorMessage: "Job queue service is not configured",
          error: err,
        });
        throw err;
      }

      let job;
      try {
        job = await this.jobQueueService.addUseCaseJob({
          useCaseId: workflow.id,
          ...(workflowOrId && typeof workflowOrId === "object" ? { workflow: workflowOrId } : {}),
          input: mergedInput,
          userId,
          executionId: resolvedRunId,
          workflowRunId: resolvedRunId,
          idempotencyKey: referenceId,
          traceId: effectiveTraceId,
          serverContext: opaqueServerContext,
        });
      } catch (dispatchErr) {
        const failMessage = `Queue dispatch failed: ${dispatchErr.message}`;
        engineLogger.error(
          {
            event: "V3_QUEUE_DISPATCH_FAILED",
            workflowId: workflow.id,
            runId: resolvedRunId,
            err: dispatchErr.message,
          },
          `[ExecutionEngine] Queue dispatch failed for "${workflow.id}".`
        );

        await this.notifyFailure({
          stage: "launch",
          runId: resolvedRunId,
          workflowId: workflow.id,
          userId,
          input: mergedInput,
          serverContext: opaqueServerContext,
          errorCode: "QUEUE_DISPATCH_FAILED",
          errorMessage: failMessage,
          error: dispatchErr,
        });

        throw new GenerationQueueDispatchError(
          `Failed to enqueue workflow "${workflow.id}": ${dispatchErr.message}`,
          { cause: dispatchErr }
        );
      }

      engineLogger.info(
        {
          event: LogEvents.USECASE_STARTED,
          workflowId: workflow.id,
          runId: resolvedRunId,
          jobId: job?.id || null,
        },
        `[ExecutionEngine] Launched workflow "${workflow.id}"`
      );

      return {
        status: "queued",
        workflowId: workflow.id,
        executionId: resolvedRunId,
        runId: resolvedRunId,
        workflowRunId: resolvedRunId,
        jobId: job?.id || null,
      };
    }

    const workflow = this.resolveWorkflow(workflowOrId);
    const effectiveRunId = runId || executionId || randomUUID();

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

    try {
      jobCtx.markRunning();

      const execResult = await this.executor.execute({
        workflow,
        input,
        jobContext: jobCtx,
        context: {
          ...nodeContext,
          runId: jobCtx.identity.runId,
          executionId: jobCtx.identity.executionId,
          jobId: jobCtx.identity.jobId,
          userId,
          workflowId: jobCtx.identity.workflowId,
        },
      });

      if (!execResult || execResult.status !== "completed") {
        throw new GenerationError({
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

      await this.notifySuccess({
        stage: "execute",
        runId: jobCtx.identity.runId,
        workflowId: workflow.id,
        userId,
        input,
        serverContext,
        result,
      });

      return result;
    } catch (err) {
      const report = ErrorSystem.process(err, {
        runId: jobCtx.identity.runId,
        executionId: jobCtx.identity.executionId,
        userId,
        nodeId: err?.nodeId,
      });
      const sanitized = sanitizeClientError(err);
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
      const failCode = sanitized.code || err.code || report.user?.code || "V3_EXECUTION_FAILED";

      await this.notifyFailure({
        stage: "execute",
        runId: jobCtx.identity.runId,
        workflowId: workflow?.id,
        userId,
        input,
        serverContext,
        nodeId: err?.nodeId || null,
        errorCode: failCode,
        errorMessage: failMsg,
        error: err,
        errorReport: err.errorReport,
      });

      jobCtx.markFailed(err);
      throw err;
    } finally {
      jobCtx.dispose();
    }
  }

  /**
   * Backward-compatible alias delegating to `runWorkflow(..., { async: true })`.
   */
  async launch({
    workflow: workflowInput = null,
    useCaseId = null,
    workflowId = null,
    input = {},
    userId = null,
    executionId = null,
    idempotencyKey = null,
    traceId = null,
    serverContext = null,
  } = {}) {
    return this.runWorkflow(workflowInput || useCaseId || workflowId, input, {
      async: true,
      userId,
      executionId,
      idempotencyKey,
      traceId,
      serverContext,
    });
  }

  /**
   * Backward-compatible alias delegating to `runWorkflow(..., { async: false })`.
   */
  async execute({
    workflow: workflowInput = null,
    useCaseId = null,
    workflowId = null,
    input = {},
    userId = null,
    executionId = null,
    runId = null,
    jobId = null,
    serverContext = null,
    jobContext = null,
    nodeContext = {},
  } = {}) {
    return this.runWorkflow(workflowInput || useCaseId || workflowId, input, {
      async: false,
      userId,
      executionId,
      runId,
      jobId,
      serverContext,
      jobContext,
      nodeContext,
    });
  }
}

export default ExecutionEngine;
