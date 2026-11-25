import { randomUUID } from "node:crypto";
import { createLogger, LogEvents, ErrorSystem, envConfig } from "#shared";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { jobQueueService as defaultJobQueueService } from "../../services/jobQueueService.js";
import { GraphCompiler } from "./GraphCompiler.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { createJobExecutionContext } from "./JobExecutionContext.js";
import { createDefaultV3NodeRegistry } from "../nodes/index.js";
import { getV3Workflow, getWorkflowContract, V3_WORKFLOW_ALIASES } from "../workflows/index.js";
import {
  GenerationError,
  GenerationValidationError,
  GenerationQueueDispatchError,
  sanitizeClientError,
} from "../../errors.js";

const engineLogger = createLogger("execution-engine");
const INLINE_TAG_REGEX = /<(character|element):([^>\s]+)>/gi;

function mergeServerContext(input = {}, serverContext = null) {
  if (!serverContext || typeof serverContext !== "object") return { ...input };
  const workflowId = serverContext.workflowId || serverContext.v1_workflow_id || input.serverWorkflowId || null;
  const mediaIds =
    Array.isArray(serverContext.mediaIds) && serverContext.mediaIds.length > 0
      ? serverContext.mediaIds
      : Array.isArray(input.serverMediaIds)
        ? input.serverMediaIds
        : [];
  const projectId = serverContext.projectId || input.serverProjectId || null;
  const characterId =
    serverContext.characterId || serverContext.character_id || input.character_id || input.characterId || null;
  const elementId =
    serverContext.elementId || serverContext.element_id || input.element_id || input.elementId || null;

  return {
    ...serverContext,
    ...input,
    ...(workflowId ? { serverWorkflowId: workflowId } : {}),
    ...(mediaIds.length > 0 ? { serverMediaIds: mediaIds } : {}),
    ...(projectId ? { serverProjectId: projectId } : {}),
    ...(characterId ? { character_id: characterId, characterId } : {}),
    ...(elementId ? { element_id: elementId, elementId } : {}),
  };
}

/**
 * ExecutionEngine (Universal Black-Box V3 Core)
 *
 * Domain-agnostic execution & error coordinator (zero media coupling, zero billing coupling):
 * - `launch(...)`: validate required inputs & ownership, compile DAG, enqueue job.
 * - `execute(...)`: run compiled DAG inside an isolated `JobExecutionContext`, classify & sanitize
 *   any error, and notify external lifecycle hooks (`onSuccess` / `onFailure`).
 * - External domain concerns (such as marking pending media rows failed) attach via `onFailure(fn)`.
 */
export class ExecutionEngine {
  constructor({
    registry = null,
    compiler = null,
    executor = null,
    identityTools = null,
    jobQueueService = undefined,
    onSuccess = null,
    onFailure = null,
  } = {}) {
    this.registry = registry || createDefaultV3NodeRegistry();
    this.compiler = compiler || new GraphCompiler(this.registry);
    this.executor = executor || new WorkflowExecutor(this.registry);

    this.identityTools = {
      assertOwns,
      assertOwnsAny,
      ...(identityTools || {}),
    };

    this.jobQueueService = jobQueueService === undefined ? defaultJobQueueService : jobQueueService;
    this.workflowAliases = V3_WORKFLOW_ALIASES;

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

  resolveContract(workflow) {
    return (
      getWorkflowContract(workflow) || {
        id: workflow.id,
        aliases: Array.isArray(workflow.aliases) ? workflow.aliases : [],
        requiredInputs: Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [],
      }
    );
  }

  /**
   * Validates ownership of explicit references AND inline `<character:id>` / `<element:id>` prompt tags
   * when present on the input.
   */
  async verifyInputOwnership(input = {}, userId) {
    const hasScopedEntities = Boolean(
      input.character_id ||
        (Array.isArray(input.characters) && input.characters.length > 0) ||
        (Array.isArray(input.elements) && input.elements.length > 0) ||
        (Array.isArray(input.references) && input.references.length > 0) ||
        input.input_media_id ||
        (typeof input.prompt === "string" && input.prompt.includes("<"))
    );

    if (!userId) {
      if (hasScopedEntities) {
        throw new GenerationValidationError("userId is required to launch a workflow with scoped references", {
          field: "userId",
        });
      }
      return;
    }

    if (input.character_id && typeof input.character_id === "string") {
      try {
        await this.identityTools.assertOwns("character", input.character_id, userId);
      } catch (err) {
        if (!input.serverWorkflowId && !input.serverProjectId && !input.serverMediaIds) {
          throw err;
        }
      }
    }

    for (const c of Array.isArray(input.characters) ? input.characters : []) {
      const charId = typeof c === "string" ? c.trim() : (c?.id || c?.characterId || "").trim();
      if (charId && !charId.startsWith("char_")) {
        await this.identityTools.assertOwns("character", charId, userId);
      }
    }

    for (const e of Array.isArray(input.elements) ? input.elements : []) {
      const elemId = typeof e === "string" ? e.trim() : (e?.id || e?.elementId || "").trim();
      if (elemId) {
        await this.identityTools.assertOwnsAny(["element", "workflow"], elemId, userId);
      }
    }

    for (const r of Array.isArray(input.references) ? input.references : []) {
      const refId = typeof r === "string" ? r.trim() : (r?.id || r?.mediaId || r?.workflowId || "").trim();
      if (refId && !refId.startsWith("http")) {
        await this.identityTools.assertOwnsAny(["media", "workflow", "character", "element"], refId, userId);
      }
    }

    if (
      input.input_media_id &&
      typeof input.input_media_id === "string" &&
      !input.input_media_id.trim().startsWith("http")
    ) {
      await this.identityTools.assertOwnsAny(["media", "workflow"], input.input_media_id.trim(), userId);
    }

    if (typeof input.prompt === "string" && input.prompt.includes("<")) {
      const seenChars = new Set();
      const seenElems = new Set();
      for (const [, kind, rawId] of input.prompt.matchAll(INLINE_TAG_REGEX)) {
        const tagId = rawId.trim();
        if (!tagId) continue;
        if (kind.toLowerCase() === "character") {
          if (!seenChars.has(tagId)) {
            seenChars.add(tagId);
            await this.identityTools.assertOwns("character", tagId, userId);
          }
        } else if (!seenElems.has(tagId)) {
          seenElems.add(tagId);
          await this.identityTools.assertOwnsAny(["element", "workflow"], tagId, userId);
        }
      }
    }
  }

  /**
   * Phase 1: Synchronous Pre-Queue Launch (validate contract & ownership -> compile DAG -> enqueue job).
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
    projectId = null,
    serverContext = null,
  } = {}) {
    const workflow = this.resolveWorkflow(
      workflowInput || useCaseId || (workflowId && getV3Workflow(workflowId) ? workflowId : null)
    );
    const contract = this.resolveContract(workflow);
    const mergedInput = mergeServerContext(input, serverContext);

    const effectiveWorkflowId = workflowId || mergedInput.workflow_id || mergedInput.serverWorkflowId || null;
    const parentDbWorkflowId =
      effectiveWorkflowId && !getV3Workflow(effectiveWorkflowId) ? effectiveWorkflowId : null;
    const resolvedProjectId =
      projectId || mergedInput.project_id || mergedInput.projectId || mergedInput.serverProjectId || null;

    // 1. Validate required inputs from workflow contract
    for (const reqField of contract.requiredInputs || []) {
      const val = mergedInput[reqField];
      if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
        throw new GenerationValidationError(
          `Workflow "${workflow.id}" requires input "${reqField}" before launch`,
          { field: reqField }
        );
      }
    }

    // 2. Verify ownership across explicit entity references and inline prompt tags
    await this.verifyInputOwnership(mergedInput, userId);

    // 3. Mint execution identity
    const runId = executionId || randomUUID();
    const effectiveTraceId = traceId || runId;
    const referenceId = idempotencyKey || `exec:${workflow.id}:${userId || "anon"}:${runId}`;

    // 4. Fail-closed DAG compilation before queueing
    this.compiler.compile(workflow);

    const effectiveServerContext = serverContext
      ? {
          ...serverContext,
          ...(parentDbWorkflowId && !serverContext.workflowId ? { workflowId: parentDbWorkflowId } : {}),
          ...(resolvedProjectId && !serverContext.projectId ? { projectId: resolvedProjectId } : {}),
        }
      : parentDbWorkflowId || resolvedProjectId
        ? { workflowId: parentDbWorkflowId, projectId: resolvedProjectId }
        : null;

    // 5. Enqueue 1 independent job
    if (!this.jobQueueService || typeof this.jobQueueService.addUseCaseJob !== "function") {
      const err = new GenerationQueueDispatchError("Job queue service is not configured for ExecutionEngine");
      await this.notifyFailure({
        stage: "launch",
        runId,
        workflowId: workflow.id,
        userId,
        input: mergedInput,
        serverContext: effectiveServerContext,
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
        ...(workflowInput && typeof workflowInput === "object" ? { workflow: workflowInput } : {}),
        input: mergedInput,
        userId,
        executionId: runId,
        workflowRunId: runId,
        idempotencyKey: referenceId,
        traceId: effectiveTraceId,
        serverContext: effectiveServerContext,
      });
    } catch (dispatchErr) {
      const failMessage = `Queue dispatch failed: ${dispatchErr.message}`;
      engineLogger.error(
        {
          event: "V3_QUEUE_DISPATCH_FAILED",
          workflowId: workflow.id,
          runId,
          err: dispatchErr.message,
        },
        `[ExecutionEngine] Queue dispatch failed for "${workflow.id}".`
      );

      await this.notifyFailure({
        stage: "launch",
        runId,
        workflowId: workflow.id,
        userId,
        input: mergedInput,
        serverContext: effectiveServerContext,
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
        runId,
        jobId: job?.id || null,
      },
      `[ExecutionEngine] Launched workflow "${workflow.id}"`
    );

    return {
      status: "queued",
      workflowId: workflow.id,
      executionId: runId,
      runId,
      workflowRunId: runId,
      jobId: job?.id || null,
    };
  }

  /**
   * Phase 2: Asynchronous Worker Execution inside an isolated `JobExecutionContext`.
   * Executes DAG waves fail-fast, sanitizes errors, and invokes external lifecycle hooks.
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
    jobContext = null,
    nodeContext = {},
  } = {}) {
    const workflow = this.resolveWorkflow(workflowInput || useCaseId || workflowId);
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
            workflowId: input?.serverWorkflowId || input?.workflow_id || null,
          });

    const useExternalPersistence =
      nodeContext?.useExternalPersistence !== undefined
        ? Boolean(nodeContext.useExternalPersistence)
        : !envConfig.isTest;

    try {
      jobCtx.markRunning();

      const execResult = await this.executor.execute({
        workflow,
        input,
        jobContext: jobCtx,
        context: {
          ...nodeContext,
          useExternalPersistence,
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
        runId: jobCtx.identity.runId,
        executionId: jobCtx.identity.executionId,
        jobId: jobCtx.identity.jobId,
        state: { ...jobCtx.state },
      };

      await this.notifySuccess({
        stage: "execute",
        runId: jobCtx.identity.runId,
        workflowId: workflow.id,
        userId,
        input,
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
}

export default ExecutionEngine;
