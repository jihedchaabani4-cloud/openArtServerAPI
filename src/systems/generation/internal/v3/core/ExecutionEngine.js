import { randomUUID } from "node:crypto";
import { createLogger, LogEvents, ErrorSystem, envConfig } from "#shared";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { reserveCredits, settleCredits, rollbackCredits, extendHold } from "#billing/tools";
import { createPendingMedia, markMediaFailed } from "#media/tools";
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

/**
 * Collects the placeholder media IDs strictly belonging to this single execution.
 */
export function collectTargetMediaIds(input = {}) {
  const ids = [
    input?.media_id,
    input?.mediaId,
    ...(Array.isArray(input?.serverMediaIds) ? input.serverMediaIds : []),
  ].filter((id) => typeof id === "string" && id.trim());
  return [...new Set(ids)];
}

/**
 * Merges server-verified context targets cleanly into runtime input.
 */
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
 * ExecutionEngine (V3 Execution Core)
 *
 * Deep, independent per-job execution engine using strictly `#identity/tools`,
 * `#billing/tools`, and `#media/tools` (zero raw DB writes, zero workflow-wide media wipes):
 * - `launch(...)`: validate contract & ownership (including inline `<character:id>`/`<element:id>`),
 *   strictly compile & estimate cost (fail-closed), reserve credit hold, ensure 1 pending media,
 *   and enqueue 1 independent job with full compensating rollback on error.
 * - `execute(...)`: create isolated `JobExecutionContext`, run hold heartbeat, execute DAG waves,
 *   settle on success or rollback hold + fail ONLY this run's media on error, dispose cache in `finally`.
 * - `rollbackHold(referenceId, metadata)`: compensating rollback for worker crash recovery.
 */
export class ExecutionEngine {
  constructor({
    registry = null,
    compiler = null,
    executor = null,
    identityTools = null,
    billingTools = null,
    mediaTools = null,
    jobQueueService = undefined,
    walletService = null,
  } = {}) {
    this.registry = registry || createDefaultV3NodeRegistry();
    this.compiler = compiler || new GraphCompiler(this.registry);
    this.executor = executor || new WorkflowExecutor(this.registry);
    this.walletService = walletService || null;

    this.identityTools = {
      assertOwns,
      assertOwnsAny,
      ...(identityTools || {}),
    };

    const customBilling = billingTools || {};
    this.billingTools = {
      reserveCredits: customBilling.reserveCredits || customBilling.reserveHold || reserveCredits,
      settleCredits: customBilling.settleCredits || customBilling.settleHold || settleCredits,
      rollbackCredits: customBilling.rollbackCredits || customBilling.releaseHold || rollbackCredits,
      extendHold: customBilling.extendHold || extendHold,
    };

    this.mediaTools = {
      createPendingMedia,
      markMediaFailed,
      ...(mediaTools || {}),
    };

    this.jobQueueService = jobQueueService === undefined ? defaultJobQueueService : jobQueueService;
    this.workflowAliases = V3_WORKFLOW_ALIASES;
  }

  _billingCtx() {
    return this.walletService ? { walletService: this.walletService } : {};
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
        aliases: workflow.aliases || [],
        mediaType: workflow.mediaType || (workflow.category === "video" ? "video" : "image"),
        mediaRole: workflow.mediaRole || (workflow.category === "character" ? "sheet" : "output"),
        saveType:
          workflow.saveType ||
          (workflow.category === "character"
            ? "character_sheet"
            : workflow.category === "video"
              ? "video_output"
              : "workflow_output"),
        requiredInputs: Array.isArray(workflow.requiredInputs) ? workflow.requiredInputs : [],
      }
    );
  }

  /**
   * Validates ownership of explicit references AND inline `<character:id>` / `<element:id>` prompt tags.
   */
  async verifyInputOwnership(input = {}, userId) {
    if (!userId) {
      throw new GenerationValidationError("userId is required to launch a workflow", {
        field: "userId",
      });
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
   * Phase 1: Synchronous Pre-Queue Launch (1 execution = 1 hold = 1 media = 1 independent job).
   */
  async launch({
    workflow: workflowInput = null,
    useCaseId = null,
    workflowId = null,
    input = {},
    userId,
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

    // 2. Verify ownership across explicit references and inline prompt tags
    await this.verifyInputOwnership(mergedInput, userId);

    // 3. Mint execution identity & deterministic billing referenceId
    const runId = executionId || randomUUID();
    const effectiveTraceId = traceId || runId;
    const referenceId = idempotencyKey || `exec:${workflow.id}:${userId}:${runId}`;

    const existingMediaId =
      mergedInput.media_id ||
      mergedInput.mediaId ||
      (Array.isArray(mergedInput.serverMediaIds) && mergedInput.serverMediaIds.length > 0
        ? mergedInput.serverMediaIds[0]
        : null);

    // 4. Strict fail-closed compilation & upfront credit estimation
    const compiledPlan = this.compiler.compile(workflow, {
      ...mergedInput,
      media_id: existingMediaId || "pending-placeholder",
    });
    const totalCredits = compiledPlan.totalEstimatedCredits;
    const costBreakdown = compiledPlan.costBreakdown || [];

    // 5. Reserve credit hold via #billing/tools
    const billingCtx = this._billingCtx();
    let reservation = null;
    if (totalCredits > 0) {
      reservation = await this.billingTools.reserveCredits(
        {
          userId,
          amount: totalCredits,
          referenceId,
          metadata: {
            kind: "v3-upfront-reserve",
            workflowId: parentDbWorkflowId || workflow.id,
            blueprintId: workflow.id,
            runId,
            mediaId: existingMediaId || null,
            totalCredits,
            costBreakdown,
          },
        },
        billingCtx
      );
    }
    const billingHoldId =
      totalCredits > 0
        ? reservation?.billingHoldId || reservation?.referenceId || reservation?.reservationId || referenceId
        : null;

    // 6. Ensure strictly 1 pending media placeholder (reuse supplied or create via #media/tools)
    let pendingMediaId = existingMediaId;
    try {
      if (!pendingMediaId) {
        const placeholder = await this.mediaTools.createPendingMedia({
          userId,
          workflowId: parentDbWorkflowId,
          projectId: resolvedProjectId,
          stepId: workflow.id,
          role: contract.mediaRole,
          saveType: contract.saveType,
          mediaType: contract.mediaType,
          width: Number(mergedInput.width || (contract.mediaRole === "sheet" ? 1344 : 1024)),
          height: Number(mergedInput.height || (contract.mediaRole === "sheet" ? 768 : 1024)),
        });
        pendingMediaId = placeholder?.mediaId || placeholder?.id || null;
      }
    } catch (mediaErr) {
      await this._rollbackSafe(billingHoldId, {
        failedMessage: mediaErr.message,
        errorCategory: "PLACEHOLDER_CREATION_FAILED",
      });
      throw mediaErr;
    }

    const runtimeInput = {
      ...mergedInput,
      ...(pendingMediaId ? { media_id: pendingMediaId } : {}),
    };
    const targetMediaIds = collectTargetMediaIds(runtimeInput);

    // 7. Enqueue 1 independent job with compensating rollback on failure
    if (!this.jobQueueService || typeof this.jobQueueService.addUseCaseJob !== "function") {
      await this._rollbackSafe(billingHoldId, { errorCategory: "QUEUE_NOT_CONFIGURED" });
      await this._markMediaIdsFailedSafe(
        targetMediaIds,
        "QUEUE_NOT_CONFIGURED",
        "Job queue service is not configured"
      );
      throw new GenerationQueueDispatchError("Job queue service is not configured for ExecutionEngine");
    }

    let job;
    try {
      job = await this.jobQueueService.addUseCaseJob({
        useCaseId: workflow.id,
        input: runtimeInput,
        userId,
        executionId: runId,
        workflowRunId: runId,
        billingHoldId,
        idempotencyKey: referenceId,
        traceId: effectiveTraceId,
        serverContext: {
          workflowId: parentDbWorkflowId,
          mediaIds: targetMediaIds,
          projectId: resolvedProjectId,
        },
      });
    } catch (dispatchErr) {
      const failMessage = `Queue dispatch failed: ${dispatchErr.message}`;
      engineLogger.error(
        {
          event: "V3_QUEUE_DISPATCH_FAILED",
          workflowId: workflow.id,
          runId,
          billingHoldId,
          mediaIds: targetMediaIds,
          err: dispatchErr.message,
        },
        `[ExecutionEngine] Queue dispatch failed for "${workflow.id}". Rolling back hold and failing placeholder.`
      );

      await this._rollbackSafe(billingHoldId, {
        failedMessage: dispatchErr.message,
        errorCategory: "QUEUE_DISPATCH_FAILED",
      });
      await this._markMediaIdsFailedSafe(targetMediaIds, "QUEUE_DISPATCH_FAILED", failMessage);

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
        billingHoldId,
        mediaId: pendingMediaId,
        totalCredits,
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
      mediaId: pendingMediaId,
      billingHoldId,
      totalEstimatedCredits: totalCredits,
      costBreakdown,
      cost: {
        totalCredits,
        currency: "credits",
        components: costBreakdown,
      },
      activeNodeIds: compiledPlan.activeNodeIds || [],
    };
  }

  /**
   * Starts a periodic hold heartbeat timer during worker execution.
   */
  startHoldHeartbeat(billingHoldId, { intervalMs = 120_000, extensionSeconds = 300, onHoldExpired = null } = {}) {
    if (!billingHoldId || typeof this.billingTools.extendHold !== "function") {
      return { stop: () => {} };
    }
    const billingCtx = this._billingCtx();
    const timer = setInterval(async () => {
      try {
        await this.billingTools.extendHold(billingHoldId, extensionSeconds, billingCtx);
      } catch (err) {
        const errCode = String(err?.code || "").toUpperCase();
        const status = Number(err?.statusCode || err?.status || 0);
        const msg = String(err?.message || "");
        const isTerminalHoldExpiry =
          errCode === "HOLD_EXPIRED" ||
          errCode === "HOLD_NOT_FOUND" ||
          status === 404 ||
          status === 409 ||
          /expired|not found|already (committed|settled|rolled back|released)/i.test(msg);

        engineLogger.warn(
          { billingHoldId, isTerminalHoldExpiry, err: err.message },
          `[ExecutionEngine] Hold heartbeat extension failed: ${err.message}`
        );

        if (isTerminalHoldExpiry) {
          clearInterval(timer);
          if (typeof onHoldExpired === "function") {
            onHoldExpired(err);
          }
        }
      }
    }, intervalMs);
    timer.unref?.();
    return {
      stop: () => clearInterval(timer),
    };
  }

  /**
   * Phase 2: Asynchronous Worker Execution & Settlement inside an isolated `JobExecutionContext`.
   */
  async execute({
    workflow: workflowInput = null,
    useCaseId = null,
    workflowId = null,
    input = {},
    userId,
    billingHoldId = null,
    executionId = null,
    runId = null,
    jobId = null,
    jobContext = null,
    nodeContext = {},
    heartbeatIntervalMs = 120_000,
  } = {}) {
    const workflow = this.resolveWorkflow(workflowInput || useCaseId || workflowId);
    const contract = this.resolveContract(workflow);
    const effectiveHoldId = billingHoldId || input?.billing_hold_id || input?.billingHoldId || null;
    const serverWorkflowId = input?.serverWorkflowId || null;
    const serverMediaIds = Array.isArray(input?.serverMediaIds) ? input.serverMediaIds : [];
    const targetMediaIds = collectTargetMediaIds(input);

    // Fail-closed server target verification
    const hasUnverifiedTargets = Boolean(
      input?.media_id && input?.characterId && !serverWorkflowId && serverMediaIds.length === 0
    );
    if (hasUnverifiedTargets) {
      const failMsg = "Persistence requires server-verified targetWorkflowId and targetMediaIds";
      await this._rollbackSafe(effectiveHoldId, {
        errorCategory: "FAIL_CLOSED_SECURITY",
        failedMessage: failMsg,
      });
      await this._markMediaIdsFailedSafe(targetMediaIds, "TARGET_VERIFICATION_FAILED", failMsg);
      throw new GenerationError({
        code: "TARGET_VERIFICATION_FAILED",
        message: failMsg,
        statusCode: 403,
        isInternal: false,
      });
    }

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
            workflowId: serverWorkflowId || input?.workflow_id || null,
            billingHoldId: effectiveHoldId,
            mediaId: targetMediaIds[0] || null,
            mediaRole: contract.mediaRole || "output",
            saveType: contract.saveType || "default",
          });

    const heartbeat = this.startHoldHeartbeat(effectiveHoldId, {
      intervalMs: heartbeatIntervalMs,
      extensionSeconds: 300,
      onHoldExpired: () => jobCtx.markHoldExpired(),
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
          mediaRole: jobCtx.resources.mediaRole,
          saveType: jobCtx.resources.saveType,
        },
      });

      if (!execResult || execResult.status !== "completed") {
        const err = new GenerationError({
          code: "WORKFLOW_INCOMPLETE",
          message: `Workflow did not complete successfully (status: ${execResult?.status || "unknown"})`,
          statusCode: 500,
          isInternal: true,
        });
        err.billingBreakdown = execResult?.billingBreakdown || [];
        throw err;
      }

      if (effectiveHoldId) {
        await this.billingTools.settleCredits(
          {
            referenceId: effectiveHoldId,
            metadata: {
              workflowId: workflow.id,
              runId: jobCtx.identity.runId,
              executionId: jobCtx.identity.executionId,
              costBreakdown: execResult.costBreakdown,
              totalEstimatedCredits: execResult.totalEstimatedCredits,
            },
          },
          this._billingCtx()
        );
      }

      jobCtx.markCompleted();

      return {
        ...execResult,
        runId: jobCtx.identity.runId,
        executionId: jobCtx.identity.executionId,
        jobId: jobCtx.identity.jobId,
        billingHoldId: effectiveHoldId,
        billingStatus: effectiveHoldId ? "settled" : "not_required",
        state: { ...jobCtx.state },
      };
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
          billingHoldId: effectiveHoldId,
          errorCode: sanitized.code,
          errorCategory: sanitized.category,
          err: err.message,
        },
        `[ExecutionEngine] Execution failed for "${workflow?.id}": ${err.message}`
      );

      await this._rollbackSafe(effectiveHoldId, {
        workflowId: workflow?.id,
        runId: jobCtx.identity.runId,
        executionId: jobCtx.identity.executionId,
        failedMessage: report.system?.rawMessage || err.message,
        errorCode: sanitized.code || report.user?.code || err.code || "V3_EXECUTION_FAILED",
        errorCategory: sanitized.category || report.user?.category || "SERVER_FAULT",
      });

      const failMsg = sanitized.userMessage || report.user?.message || "Workflow execution failed";
      const failCode = sanitized.code || err.code || report.user?.code || "V3_EXECUTION_FAILED";
      await this._markMediaIdsFailedSafe(targetMediaIds, failCode, failMsg);

      jobCtx.markFailed(err);
      throw err;
    } finally {
      heartbeat.stop();
      jobCtx.dispose();
    }
  }

  /**
   * Compensating rollback for held credits (e.g. from worker crash recovery).
   */
  async rollbackHold(referenceId, metadata = {}) {
    if (!referenceId) return null;
    return this.billingTools.rollbackCredits(
      {
        referenceId,
        metadata: metadata || {},
      },
      this._billingCtx()
    );
  }

  async _rollbackSafe(billingHoldId, metadata = {}) {
    if (!billingHoldId) return;
    await this.billingTools
      .rollbackCredits(
        {
          referenceId: billingHoldId,
          metadata,
        },
        this._billingCtx()
      )
      .catch((rbErr) => {
        engineLogger.warn(
          { billingHoldId, err: rbErr?.message },
          "[ExecutionEngine] Credit hold rollback encountered an error"
        );
      });
  }

  async _markMediaIdsFailedSafe(mediaIds, errorCode, errorMessage) {
    for (const mediaId of mediaIds) {
      await this.mediaTools
        .markMediaFailed({
          mediaId,
          errorCode,
          errorMessage,
        })
        .catch((mediaErr) => {
          engineLogger.warn(
            { mediaId, errorCode, err: mediaErr?.message },
            "[ExecutionEngine] markMediaFailed encountered an error"
          );
        });
    }
  }
}

export default ExecutionEngine;
