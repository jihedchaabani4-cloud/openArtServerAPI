import { randomUUID } from "node:crypto";
import { createLogger, LogEvents } from "#shared";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { reserveCredits, settleCredits, rollbackCredits, extendHold } from "#billing/tools";
import { createPendingMedia, markMediaFailed } from "#media/tools";
import { jobQueueService as defaultJobQueueService } from "../../services/jobQueueService.js";
import { GraphCompiler } from "./GraphCompiler.js";
import { WorkflowExecutor } from "./WorkflowExecutor.js";
import { createDefaultV3NodeRegistry } from "../nodes/index.js";
import { getV3Workflow, resolveV3WorkflowId, V3_WORKFLOW_ALIASES } from "../workflows/index.js";
import {
  GenerationValidationError,
  GenerationQueueDispatchError,
} from "../../errors.js";

const v3DispatcherLogger = createLogger("v3-dispatcher");

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
  } = {}) {
    this.registry = registry || createDefaultV3NodeRegistry();
    this.compiler = compiler || new GraphCompiler(this.registry);
    this.executor = executor || new WorkflowExecutor(this.registry);

    this.identityTools = {
      assertOwns,
      assertOwnsAny,
      ...(identityTools || {}),
    };

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
      await this.identityTools.assertOwns("character", input.character_id, userId);
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
  } = {}) {
    const workflow = this.resolveWorkflow(
      workflowInput || useCaseId || (workflowId && getV3Workflow(workflowId) ? workflowId : null)
    );
    const parentDbWorkflowId =
      workflowId && !getV3Workflow(workflowId) ? workflowId : (input.workflow_id || null);

    // Step 1: Verify ownership of any input references
    await this.verifyInputOwnership(input, userId);

    const runId = executionId || randomUUID();
    const effectiveTraceId = traceId || runId;
    const referenceId = idempotencyKey || `v3:${workflow.id}:${userId}:${runId}`;

    // Step 2: Compile graph & compute deterministic upfront credit cost across active nodes
    const compiledPlan = this.compiler.compile(workflow, {
      ...input,
      media_id: input.media_id || "pending-placeholder",
      character_id: input.character_id || "pending-character",
    });

    const totalCredits = compiledPlan.totalEstimatedCredits;

    // Step 3: Reserve credit hold before creating placeholders or queueing
    let reservation = null;
    if (totalCredits > 0) {
      reservation = await this.billingTools.reserveHold({
        userId,
        amount: totalCredits,
        referenceId,
        metadata: {
          kind: "v3-upfront-reserve",
          workflowId: workflow.id,
          runId,
          totalCredits,
          costBreakdown: compiledPlan.costBreakdown,
        },
      });
    }

    const billingHoldId = totalCredits > 0 ? (reservation?.referenceId || referenceId) : null;

    // Step 4: Create pending media placeholder if not already provided in input
    let pendingMediaId = input.media_id || null;
    let createdPlaceholder = false;
    try {
      if (!pendingMediaId) {
        const placeholder = await this.mediaTools.createPendingMedia({
          userId,
          workflowId: parentDbWorkflowId,
          projectId: projectId || input.project_id || null,
          stepId: workflow.id,
          width: Number(input.width || 1024),
          height: Number(input.height || 1024),
        });
        pendingMediaId = placeholder?.mediaId || placeholder?.id;
        createdPlaceholder = true;
      }
    } catch (mediaErr) {
      if (billingHoldId) {
        await this.billingTools
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
      ...input,
      media_id: pendingMediaId,
    };

    // Step 5: Protected Queue Dispatch with immediate rollback on failure
    if (!this.jobQueueService || typeof this.jobQueueService.addUseCaseJob !== "function") {
      if (billingHoldId) {
        await this.billingTools.releaseHold({ referenceId: billingHoldId }).catch(() => {});
      }
      if (pendingMediaId && createdPlaceholder) {
        await this.mediaTools
          .markMediaFailed({
            mediaId: pendingMediaId,
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
          mediaId: pendingMediaId,
          err: dispatchErr.message,
        },
        `[V3Dispatcher] Queue dispatch failed for "${workflow.id}". Rolling back hold and failing placeholder.`
      );

      if (billingHoldId) {
        await this.billingTools
          .releaseHold({
            referenceId: billingHoldId,
            metadata: {
              failedMessage: dispatchErr.message,
              errorCategory: "QUEUE_DISPATCH_FAILED",
            },
          })
          .catch(() => {});
      }

      if (pendingMediaId) {
        await this.mediaTools
          .markMediaFailed({
            mediaId: pendingMediaId,
            errorCode: "QUEUE_DISPATCH_FAILED",
            errorMessage: `Queue dispatch failed: ${dispatchErr.message}`,
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
      costBreakdown: compiledPlan.costBreakdown,
      cost: {
        totalCredits,
        currency: "credits",
        components: compiledPlan.costBreakdown,
      },
      activeNodeIds: compiledPlan.activeNodeIds,
    };
  }

  /**
   * Starts a periodic hold heartbeat timer during worker execution.
   */
  startHoldHeartbeat(billingHoldId, { intervalMs = 120_000, extensionSeconds = 300 } = {}) {
    if (!billingHoldId || typeof this.billingTools.extendHold !== "function") {
      return { stop: () => {} };
    }
    const timer = setInterval(async () => {
      try {
        await this.billingTools.extendHold(billingHoldId, extensionSeconds);
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
    const heartbeat = this.startHoldHeartbeat(effectiveHoldId, {
      intervalMs: heartbeatIntervalMs,
      extensionSeconds: 300,
    });

    try {
      const execResult = await this.executor.execute({
        workflow,
        input,
        context: {
          ...nodeContext,
          runId: effectiveRunId,
          userId,
        },
      });

      if (effectiveHoldId) {
        await this.billingTools.settleHold({
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
      v3DispatcherLogger.error(
        {
          event: LogEvents.USECASE_FAILED,
          workflowId: workflow?.id,
          runId: effectiveRunId,
          billingHoldId: effectiveHoldId,
          err: err.message,
        },
        `[V3Dispatcher] Execution failed for "${workflow?.id}": ${err.message}`
      );

      if (effectiveHoldId) {
        await this.billingTools
          .releaseHold({
            referenceId: effectiveHoldId,
            metadata: {
              workflowId: workflow?.id,
              runId: effectiveRunId,
              failedMessage: err.message,
              errorCode: err.code || "V3_EXECUTION_FAILED",
            },
          })
          .catch((rbErr) => {
            v3DispatcherLogger.warn(
              { billingHoldId: effectiveHoldId, err: rbErr.message },
              "[V3Dispatcher] Hold release on failure encountered an error"
            );
          });
      }

      const targetMediaId = input?.media_id || input?.mediaId || null;
      if (targetMediaId) {
        await this.mediaTools
          .markMediaFailed({
            mediaId: targetMediaId,
            errorCode: err.code || "V3_EXECUTION_FAILED",
            errorMessage: err.message || "Workflow execution failed",
          })
          .catch(() => {});
      }

      throw err;
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * Alias for worker compatibility (`executeQueuedUseCase` -> `executeQueuedV3Run`).
   */
  async executeQueuedUseCase(params = {}) {
    return this.executeQueuedV3Run(params);
  }
}

export default V3Dispatcher;

