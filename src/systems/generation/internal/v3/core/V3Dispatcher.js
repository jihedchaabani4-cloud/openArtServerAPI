import { randomUUID } from "node:crypto";
import { createLogger, LogEvents, ErrorSystem } from "#shared";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { reserveCredits, settleCredits, rollbackCredits, extendHold } from "#billing/tools";
import { createPendingMedia, markMediaFailed, failWorkflowPendingMedia } from "#media/tools";
import { jobQueueService as defaultJobQueueService } from "../../services/jobQueueService.js";
import { GraphCompiler } from "./GraphCompiler.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { createDefaultV3NodeRegistry } from "../nodes/index.js";
import { getV3Workflow, resolveV3WorkflowId, getWorkflowContract, V3_WORKFLOW_ALIASES } from "../workflows/index.js";
import {
  GenerationError,
  GenerationValidationError,
  GenerationQueueDispatchError,
  sanitizeClientError,
} from "../../errors.js";
import { db as defaultDb } from "../../db/dbMap.js";

const v3DispatcherLogger = createLogger("v3-dispatcher");

/**
 * Collects every placeholder media ID a run is responsible for, so a failure
 * never leaves zombie "processing" rows behind (single or multi-output runs).
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
 * Merges legacy caller `serverContext` targets into the runtime input so the
 * queued job carries all server-side targets (workflow, media, project).
 */
function mergeServerContext(input = {}, serverContext = null) {
  if (!serverContext || typeof serverContext !== "object") return { ...input };
  const workflowId = serverContext.workflowId || serverContext.v1_workflow_id || input.serverWorkflowId || null;
  const mediaIds = Array.isArray(serverContext.mediaIds) && serverContext.mediaIds.length > 0
    ? serverContext.mediaIds
    : (Array.isArray(input.serverMediaIds) ? input.serverMediaIds : []);
  const projectId = serverContext.projectId || input.serverProjectId || null;
  const characterId = serverContext.characterId || serverContext.character_id || input.character_id || input.characterId || null;
  const elementId = serverContext.elementId || serverContext.element_id || input.element_id || input.elementId || null;

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
 * V3Dispatcher (ComfyUI-Style Node Engine V3)
 *
 * Implements the mandatory 5-Step Pre-Queue Launch & 3-Step Worker Settlement Protocol:
 *
 * Phase 1 (`prepareAndEnqueue`):
 *   1. Verify ownership of referenced resources via `#identity/tools` (`assertOwns` / `assertOwnsAny`)
 *   2. Compile graph & calculate deterministic upfront credit cost via `GraphCompiler`
 *   3. Reserve credit hold via `#billing/tools` (`reserveCredits` / `reserveHold`)
 *   4. Create pending placeholder media via `#media/tools` (`createPendingMedia`) if not already supplied
 *   5. Enqueue job into BullMQ (`queue.addUseCaseJob`), with immediate compensating rollback
 *      (`rollbackCredits` + `markMediaFailed`) if queue dispatch fails.
 *
 * Phase 2 (`executeQueuedV3Run`):
 *   1. Start hold heartbeat timer to keep reservation alive during long video/image runs
 *   2. Execute pruned workflow waves via `WorkflowExecutor`
 *   3. On success -> `settleCredits` (`settleHold`)
 *      On error   -> `rollbackCredits` (`releaseHold`) + `markMediaFailed`
 *      Finally    -> stop hold heartbeat timer
 */
export class V3Dispatcher {
  constructor({
    registry = null,
    compiler = null,
    executor = null,
    identityTools = null,
    billingTools = null,
    mediaTools = null,
    jobQueueService = undefined,
    db = null,
    walletService = null,
  } = {}) {
    this.db = db || defaultDb;
    this.registry = registry || createDefaultV3NodeRegistry();
    this.compiler = compiler || new GraphCompiler(this.registry);
    this.executor = executor || new WorkflowExecutor(this.registry);

    this.identityTools = {
      assertOwns,
      assertOwnsAny,
      ...(identityTools || {}),
    };

    this._injectedBillingTools = billingTools;
    this.walletService = walletService;

    this.billingTools = {
      reserveHold: reserveCredits,
      settleHold: settleCredits,
      releaseHold: rollbackCredits,
      extendHold,
      ...(billingTools || {}),
    };

    this.mediaTools = {
      createPendingMedia,
      markMediaFailed,
      ...(mediaTools || {}),
    };

    this.jobQueueService = jobQueueService === undefined ? defaultJobQueueService : jobQueueService;
    this.workflowAliases = V3_WORKFLOW_ALIASES;
  }

  getHoldTTLForUseCase(useCaseId) {
    if (useCaseId === "video-generation-v1" || useCaseId === "videoGeneration" || String(useCaseId).includes("video")) {
      return 1800;
    }
    return 600;
  }

  /**
   * Dynamically resolves billing functions allowing per-test walletService or billingTools injection.
   */
  getResolvedBillingTools() {
    const custom = this.billingTools || {};
    if (this._injectedBillingTools) {
      return {
        ...custom,
        ...this._injectedBillingTools,
      };
    }
    const wallet = this.walletService || null;

    if (wallet && (typeof wallet.reserve === "function" || typeof wallet.reserveCredits === "function")) {
      return {
        reserveHold: async ({ userId, amount, referenceId, metadata }) => {
          if (typeof wallet.reserveCredits === "function") {
            return wallet.reserveCredits({ userId, amount, referenceId, metadata });
          }
          return wallet.reserve({ userId, amount, referenceId, metadata });
        },
        settleHold: async ({ referenceId, metadata }) => {
          if (typeof wallet.settleCredits === "function") {
            return wallet.settleCredits(referenceId, metadata);
          }
          if (typeof wallet.settle === "function") {
            return wallet.settle(referenceId, metadata);
          }
          return wallet.commitHoldIdempotent
            ? wallet.commitHoldIdempotent(referenceId, metadata)
            : wallet.commit?.(referenceId, metadata);
        },
        releaseHold: async ({ referenceId, metadata }) => {
          if (typeof wallet.rollbackCredits === "function") {
            return wallet.rollbackCredits(referenceId, metadata);
          }
          if (typeof wallet.rollbackHoldIdempotent === "function") {
            return wallet.rollbackHoldIdempotent(referenceId, metadata);
          }
          if (typeof wallet.release === "function") {
            return wallet.release(referenceId, metadata);
          }
          return wallet.rollback?.(referenceId, metadata);
        },
        extendHold: async (holdId, ttlSeconds) => {
          if (typeof wallet.extendHold === "function") {
            return wallet.extendHold(holdId, ttlSeconds);
          }
          return custom.extendHold?.(holdId, ttlSeconds);
        },
      };
    }
    return custom;
  }

  /**
   * Resolves a workflow blueprint from a blueprint object, V3 workflow ID, or legacy V1 UseCase alias.
   *
   * @param {Object|string} workflowOrId
   * @returns {Object}
   */
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
   * Verifies user ownership of any referenced characters, elements, or media IDs in the input.
   */
  async verifyInputOwnership(input = {}, userId) {
    if (!userId) {
      throw new GenerationValidationError("userId is required to launch a V3 workflow", {
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

    const characters = Array.isArray(input.characters) ? input.characters : [];
    for (const c of characters) {
      const charId = typeof c === "string" ? c : c?.id || c?.characterId;
      if (charId && !String(charId).startsWith("char_")) {
        await this.identityTools.assertOwns("character", charId, userId);
      }
    }

    const elements = Array.isArray(input.elements) ? input.elements : [];
    for (const e of elements) {
      const elemId = typeof e === "string" ? e : e?.id || e?.elementId;
      if (elemId) {
        await this.identityTools.assertOwnsAny(["element", "workflow"], elemId, userId);
      }
    }

    const refs = Array.isArray(input.references) ? input.references : [];
    for (const r of refs) {
      const refId = typeof r === "string" ? r : r?.id || r?.mediaId || r?.workflowId;
      if (refId && !String(refId).startsWith("http")) {
        await this.identityTools.assertOwnsAny(
          ["media", "workflow", "character", "element"],
          refId,
          userId
        );
      }
    }

    if (
      input.input_media_id &&
      typeof input.input_media_id === "string" &&
      !input.input_media_id.startsWith("http")
    ) {
      await this.identityTools.assertOwnsAny(["media", "workflow"], input.input_media_id, userId);
    }
  }

  /**
   * Phase 1: Synchronous Pre-Queue Launch
   *
   * @param {Object} params
   * @param {Object|string} [params.workflow] - V3 workflow blueprint or workflow ID
   * @param {string} [params.useCaseId] - Optional UseCase ID or alias (e.g. "image-generation-v1")
   * @param {Object} [params.input={}] - Initial workflow inputs
   * @param {string} params.userId - Calling user ID
   * @param {string} [params.executionId]
   * @param {string} [params.idempotencyKey]
   * @param {string} [params.traceId]
   * @param {string} [params.workflowId] - Optional parent DB workflow ID or V3 workflow ID
   * @param {string} [params.projectId] - Optional project ID
   * @returns {Promise<Object>}
   */
  async prepareAndEnqueue({
    workflow: workflowInput = null,
    useCaseId = null,
    input = {},
    userId,
    executionId = null,
    idempotencyKey = null,
    traceId = null,
    workflowId = null,
    projectId = null,
    serverContext = null,
  } = {}) {
    const workflow = this.resolveWorkflow(
      workflowInput || useCaseId || (workflowId && getV3Workflow(workflowId) ? workflowId : null)
    );
    const contract = getWorkflowContract(workflow) || {
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
    };
    const mergedInput = mergeServerContext(input, serverContext);
    const effectiveWorkflowId = workflowId || mergedInput.workflow_id || mergedInput.serverWorkflowId || null;
    const parentDbWorkflowId =
      effectiveWorkflowId && !getV3Workflow(effectiveWorkflowId) ? effectiveWorkflowId : null;

    // Validate workflow contract requiredInputs before launching
    for (const reqField of contract.requiredInputs || []) {
      const val = mergedInput[reqField];
      if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
        throw new GenerationValidationError(
          `Workflow "${workflow.id}" requires input "${reqField}" before launch`,
          { field: reqField }
        );
      }
    }

    // Step 1: Verify ownership of any input references
    await this.verifyInputOwnership(mergedInput, userId);

    const runId = executionId || randomUUID();
    const effectiveTraceId = traceId || runId;
    const referenceId = idempotencyKey || `v3:${workflow.id}:${userId}:${runId}`;

    // Step 2: Compile graph & compute deterministic upfront credit cost across active nodes
    let compiledPlan = {
      workflowId: workflow.id,
      version: workflow.version || "3.0.0",
      activeNodeIds: Array.isArray(workflow.nodes) ? workflow.nodes.map((n) => n.id) : [],
      waves: [],
      totalEstimatedCredits: 1,
      costBreakdown: [],
    };
    let totalCredits = 1;
    try {
      compiledPlan = this.compiler.compile(workflow, {
        ...mergedInput,
        media_id:
          mergedInput.media_id ||
          mergedInput.mediaId ||
          (Array.isArray(mergedInput.serverMediaIds) && mergedInput.serverMediaIds.length > 0
            ? mergedInput.serverMediaIds[0]
            : "pending-placeholder"),
      });
      totalCredits = compiledPlan.totalEstimatedCredits;
    } catch (compileErr) {
      if (
        compileErr.code === "UNSUPPORTED_CAPABILITY" ||
        compileErr.message?.includes("capability") ||
        compileErr.message?.includes("pricing") ||
        compileErr.message?.includes("model")
      ) {
        totalCredits = 1;
      } else {
        throw compileErr;
      }
    }

    const billing = this.getResolvedBillingTools();

    // Step 3: Reserve credit hold before creating placeholders or queueing
    let reservation = null;
    if (totalCredits > 0) {
      reservation = await billing.reserveHold({
        userId,
        amount: totalCredits,
        referenceId,
        metadata: {
          kind: "v3-upfront-reserve",
          workflowId: workflow.id,
          runId,
          totalCredits,
          costBreakdown: compiledPlan?.costBreakdown || [],
        },
      });
    }

    const billingHoldId = totalCredits > 0 ? (reservation?.billingHoldId || reservation?.referenceId || referenceId) : null;

    // Step 4: Unified media_id preparation using workflow contract (mediaType, mediaRole, saveType)
    // If caller already supplied media_id (or serverMediaIds), reuse it directly without creating a new row.
    // Otherwise, create a new "processing" media row (linked to project_id if present) and store its media_id.
    let pendingMediaId =
      mergedInput.media_id ||
      mergedInput.mediaId ||
      (Array.isArray(mergedInput.serverMediaIds) && mergedInput.serverMediaIds.length > 0
        ? mergedInput.serverMediaIds[0]
        : null);
    try {
      if (!pendingMediaId) {
        const resolvedProjectId =
          projectId || mergedInput.project_id || mergedInput.projectId || mergedInput.serverProjectId || null;
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
        pendingMediaId = placeholder?.mediaId || placeholder?.id;
      }
    } catch (mediaErr) {
      if (billingHoldId) {
        await billing
          .releaseHold({
            referenceId: billingHoldId,
            metadata: {
              failedMessage: mediaErr.message,
              errorCategory: "PLACEHOLDER_CREATION_FAILED",
            },
          })
          .catch(() => {});
      }
      throw mediaErr;
    }

    const runtimeInput = {
      ...mergedInput,
      ...(pendingMediaId ? { media_id: pendingMediaId } : {}),
    };

    const targetMediaIds = collectTargetMediaIds(runtimeInput);

    // Step 5: Protected Queue Dispatch with immediate rollback on failure
    if (!this.jobQueueService || typeof this.jobQueueService.addUseCaseJob !== "function") {
      if (billingHoldId) {
        await billing.releaseHold({ referenceId: billingHoldId }).catch(() => {});
      }
      for (const mId of targetMediaIds) {
        await this.mediaTools
          .markMediaFailed({
            mediaId: mId,
            errorCode: "QUEUE_NOT_CONFIGURED",
            errorMessage: "Job queue service is not configured",
          })
          .catch(() => {});
      }
      throw new GenerationQueueDispatchError("Job queue service is not configured for V3Dispatcher");
    }

    let job;
    try {
      job = await this.jobQueueService.addUseCaseJob({
        useCaseId: workflow.id,
        input: runtimeInput,
        userId,
        serverContext: {
          workflowId: parentDbWorkflowId,
          v1_workflow_id: parentDbWorkflowId,
          mediaIds: targetMediaIds,
          projectId: projectId || runtimeInput.project_id || null,
        },
        executionId: runId,
        workflowRunId: runId,
        billingHoldId,
        idempotencyKey: referenceId,
        traceId: effectiveTraceId,
      });
    } catch (dispatchErr) {
      v3DispatcherLogger.error(
        {
          event: "V3_QUEUE_DISPATCH_FAILED",
          workflowId: workflow.id,
          billingHoldId,
          mediaIds: targetMediaIds,
          err: dispatchErr.message,
        },
        `[V3Dispatcher] Queue dispatch failed for "${workflow.id}". Rolling back hold and failing placeholder(s).`
      );

      const failMessage = `Queue dispatch failed: ${dispatchErr.message}`;
      if (billingHoldId) {
        await billing
          .releaseHold({
            referenceId: billingHoldId,
            metadata: {
              failedMessage: dispatchErr.message,
              errorCategory: "QUEUE_DISPATCH_FAILED",
            },
          })
          .catch(() => {});
      }

      if (parentDbWorkflowId && this.db?.media) {
        await failWorkflowPendingMedia(this.db, parentDbWorkflowId, failMessage).catch(() => {});
      }

      if (this.db?.media && typeof this.db.media.updateMedia === "function") {
        for (const mId of targetMediaIds) {
          await this.db.media.updateMedia(mId, {
            status: "failed",
            error_message: failMessage,
          }).catch(() => {});
        }
      }

      for (const mId of targetMediaIds) {
        await this.mediaTools
          .markMediaFailed({
            mediaId: mId,
            errorCode: "QUEUE_DISPATCH_FAILED",
            errorMessage: failMessage,
          })
          .catch(() => {});
      }

      throw new GenerationQueueDispatchError(
        `Failed to enqueue V3 workflow "${workflow.id}": ${dispatchErr.message}`,
        { cause: dispatchErr }
      );
    }

    v3DispatcherLogger.info(
      {
        event: LogEvents.USECASE_STARTED,
        workflowId: workflow.id,
        runId,
        jobId: job?.id,
        billingHoldId,
        mediaId: pendingMediaId,
        totalCredits,
      },
      `[V3Dispatcher] Prepared and enqueued V3 workflow "${workflow.id}"`
    );

    return {
      status: "queued",
      workflowId: workflow.id,
      workflowRunId: runId,
      executionId: runId,
      runId,
      jobId: job?.id || null,
      mediaId: pendingMediaId,
      billingHoldId,
      totalEstimatedCredits: totalCredits,
      costBreakdown: compiledPlan?.costBreakdown || [],
      cost: {
        totalCredits,
        currency: "credits",
        components: compiledPlan?.costBreakdown || [],
      },
      activeNodeIds: compiledPlan?.activeNodeIds || [],
    };
  }

  /**
   * Starts a periodic hold heartbeat timer during worker execution.
   */
  startHoldHeartbeat(billingHoldId, { intervalMs = 120_000, extensionSeconds = 300 } = {}) {
    const billing = this.getResolvedBillingTools();
    if (!billingHoldId || typeof billing.extendHold !== "function") {
      return { stop: () => {} };
    }
    const timer = setInterval(async () => {
      try {
        await billing.extendHold(billingHoldId, extensionSeconds);
      } catch (err) {
        v3DispatcherLogger.warn(
          { billingHoldId, err: err.message },
          `[V3Dispatcher] Hold heartbeat extension failed: ${err.message}`
        );
      }
    }, intervalMs);
    timer.unref?.();
    return {
      stop: () => clearInterval(timer),
    };
  }

  /**
   * Phase 2: Asynchronous Worker Execution & Settlement
   *
   * @param {Object} params
   * @param {Object|string} [params.workflow] - V3 workflow blueprint or workflow ID
   * @param {string} [params.useCaseId] - Optional UseCase ID or alias
   * @param {string} [params.workflowId] - Optional workflow ID
   * @param {Object} [params.input={}] - Queued runtime inputs (including `media_id`)
   * @param {string} params.userId - Calling user ID
   * @param {string} [params.billingHoldId] - Reserved credit hold reference ID
   * @param {string} [params.runId] - Workflow run ID
   * @param {string} [params.executionId] - Optional alias for runId
   * @param {Object} [params.nodeContext={}] - Optional node execution overrides
   * @param {number} [params.heartbeatIntervalMs=120000]
   * @returns {Promise<Object>}
   */
  async executeQueuedV3Run({
    workflow: workflowInput = null,
    useCaseId = null,
    workflowId = null,
    input = {},
    userId,
    billingHoldId = null,
    runId = null,
    executionId = null,
    nodeContext = {},
    heartbeatIntervalMs = 120_000,
  } = {}) {
    const workflow = this.resolveWorkflow(workflowInput || useCaseId || workflowId);
    const effectiveRunId = runId || executionId || randomUUID();
    const effectiveHoldId = billingHoldId || input?.billing_hold_id || input?.billingHoldId || null;
    const billing = this.getResolvedBillingTools();

    const serverWorkflowId = input?.serverWorkflowId || null;
    const serverMediaIds = Array.isArray(input?.serverMediaIds) ? input.serverMediaIds : [];
    const hasUnverifiedTargets = Boolean(
      input?.media_id && input?.characterId && !serverWorkflowId && serverMediaIds.length === 0
    );

    if (hasUnverifiedTargets) {
      if (effectiveHoldId) {
        await billing
          .releaseHold({
            referenceId: effectiveHoldId,
            metadata: {
              errorCategory: "FAIL_CLOSED_SECURITY",
              failedMessage: "Persistence requires server-verified targetWorkflowId and targetMediaIds",
            },
          })
          .catch(() => {});
      }
      const failMsg = "Persistence requires server-verified targetWorkflowId and targetMediaIds";
      const targetWfId = input?.workflow_id || null;
      if (targetWfId && this.db?.media) {
        if (typeof this.db.media.failPendingMediaByWorkflow === "function") {
          await this.db.media.failPendingMediaByWorkflow(targetWfId, failMsg).catch(() => {});
        }
        await failWorkflowPendingMedia(this.db, targetWfId, failMsg).catch(() => {});
      }
      throw new GenerationError({
        code: "TARGET_VERIFICATION_FAILED",
        message: failMsg,
        statusCode: 403,
        isInternal: false,
      });
    }

    const contract = getWorkflowContract(workflow) || {};
    const heartbeat = this.startHoldHeartbeat(effectiveHoldId, {
      intervalMs: heartbeatIntervalMs,
      extensionSeconds: 300,
    });

    try {
      const execResult = await this.executor.execute({
        workflow,
        input,
        context: {
          db: this.db,
          mediaRepository: this.db?.media,
          workflowMediaRepository: this.db?.workflowMedia,
          workflowId: serverWorkflowId || input?.workflow_id || null,
          mediaRole: contract.mediaRole || "output",
          saveType: contract.saveType || "default",
          ...nodeContext,
          runId: effectiveRunId,
          userId,
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
        await billing.settleHold({
          referenceId: effectiveHoldId,
          metadata: {
            workflowId: workflow.id,
            runId: effectiveRunId,
            costBreakdown: execResult.costBreakdown,
            totalEstimatedCredits: execResult.totalEstimatedCredits,
          },
        });
      }

      return {
        ...execResult,
        runId: effectiveRunId,
        billingHoldId: effectiveHoldId,
        billingStatus: effectiveHoldId ? "settled" : "not_required",
      };
    } catch (err) {
      const report = ErrorSystem.process(err, {
        runId: effectiveRunId,
        userId,
        nodeId: err?.nodeId,
      });
      const sanitized = sanitizeClientError(err);
      err.errorReport = {
        ...report,
        sanitized,
      };

      v3DispatcherLogger.error(
        {
          event: LogEvents.USECASE_FAILED,
          workflowId: workflow?.id,
          runId: effectiveRunId,
          billingHoldId: effectiveHoldId,
          errorCode: sanitized.code,
          errorCategory: sanitized.category,
          err: err.message,
        },
        `[V3Dispatcher] Execution failed for "${workflow?.id}": ${err.message}`
      );

      if (effectiveHoldId) {
        await billing
          .releaseHold({
            referenceId: effectiveHoldId,
            metadata: {
              workflowId: workflow?.id,
              runId: effectiveRunId,
              failedMessage: report.system?.rawMessage || err.message,
              errorCode: sanitized.code || report.user?.code || err.code || "V3_EXECUTION_FAILED",
              errorCategory: sanitized.category || report.user?.category || "SERVER_FAULT",
            },
          })
          .catch((rbErr) => {
            v3DispatcherLogger.warn(
              { billingHoldId: effectiveHoldId, err: rbErr.message },
              "[V3Dispatcher] Hold release on failure encountered an error"
            );
          });
      }

      const targetWorkflowId = input?.serverWorkflowId || input?.workflow_id || null;
      const failMsg = sanitized.userMessage || report.user?.message || "Workflow execution failed";
      const failCode = sanitized.code || err.code || report.user?.code || "V3_EXECUTION_FAILED";

      if (targetWorkflowId && this.db?.media) {
        if (typeof this.db.media.findByWorkflow === "function" && typeof this.db.media.updateMedia === "function") {
          const rows = await this.db.media.findByWorkflow(targetWorkflowId).catch(() => []);
          for (const row of rows || []) {
            if (row?.id && (row.status === "processing" || row.status === "pending")) {
              await this.db.media.updateMedia(row.id, {
                status: "failed",
                error_message: failMsg,
              }).catch(() => {});
            }
          }
        }
        if (typeof this.db.media.failPendingMediaByWorkflow === "function") {
          await this.db.media.failPendingMediaByWorkflow(targetWorkflowId, failMsg).catch(() => {});
        }
        await failWorkflowPendingMedia(this.db, targetWorkflowId, failMsg).catch(() => {});
      }

      const failureMediaIds = collectTargetMediaIds(input);
      if (this.db?.media && typeof this.db.media.updateMedia === "function") {
        for (const mId of failureMediaIds) {
          await this.db.media.updateMedia(mId, {
            status: "failed",
            error_message: failMsg,
          }).catch(() => {});
        }
      }
      for (const mId of failureMediaIds) {
        await this.mediaTools
          .markMediaFailed({
            mediaId: mId,
            errorCode: failCode,
            errorMessage: failMsg,
          })
          .catch(() => {});
      }

      throw err;
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * Compensating rollback for held credits (e.g. from worker crash handler).
   */
  async rollbackPreparedBilling(referenceId, extraMetadata = null) {
    if (!referenceId) return;
    const billing = this.getResolvedBillingTools();
    return billing.releaseHold({
      referenceId,
      metadata: extraMetadata || {},
    });
  }

  /**
   * Settles a previously prepared credit hold.
   */
  async settlePreparedBilling(referenceId, extraMetadata = null) {
    if (!referenceId) return;
    const billing = this.getResolvedBillingTools();
    return billing.settleHold({
      referenceId,
      metadata: extraMetadata || {},
    });
  }

  /**
   * Alias for worker compatibility (`executeQueuedUseCase` -> `executeQueuedV3Run`).
   */
  async executeQueuedUseCase(params = {}) {
    return this.executeQueuedV3Run(params);
  }
}

export default V3Dispatcher;

