import { parseBinding } from "../compiler/validateBindings.js";
import { RunRepository } from "./runRepository.js";
import { executeNode } from "../nodes/index.js";
import {
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
  isProviderBackedNodeType,
  estimateNodeBillingAmount,
  getRunBillingAccumulator,
  getGateways,
} from "./workflowRunner.js";
import { jobQueueService } from "../../services/jobQueueService.js";
import { db } from "../../container.js";
import { nodeFailure, nodeSuccess } from "../runtime/nodeEnvelope.js";
import { formatWorkflowError } from "../runtime/errorPolicy.js";
import { createLogger, LogEvents } from "../../infrastructure/logging/index.js";

const nodeLogger = createLogger("node");

const runRepo = new RunRepository();

/**
 * Executes declarative node-level persistence from YAML (target: "character" | "media")
 */
export async function executeNodePersistence({ nodeConfig, output, run, resolvedInputs = {} }) {
  if (!nodeConfig?.persist) return;

  const { target, step_id, field, value, status = "completed" } = nodeConfig.persist;
  const workflowId = run.input?.workflow_id || run.input?.characterId;
  const projectId = run.input?.project_id || run.input?.projectId;

  const resolvedValue = typeof value === "string" && value.startsWith("$output")
    ? getValueAtPath(output, value.replace(/^\$outputs?\./, ""))
    : value;

  try {
    if (target === "character" && workflowId && field) {
      nodeLogger.info({ workflowId, field }, `Updating character ${workflowId} field "${field}"`);
      await db.characters.updateCharacter(workflowId, { [field]: resolvedValue }).catch(() => null);
    } else if (target === "media" && workflowId) {
      const mediaUrl = typeof resolvedValue === "string" ? resolvedValue : (resolvedValue?.url || output?.assets?.[0]?.url || output?.media?.url);
      if (mediaUrl) {
        const targetStepId = step_id || "character_sheet";
        nodeLogger.info({ workflowId, stepId: targetStepId }, `Updating media for workflow ${workflowId} (step_id: ${targetStepId}) to completed`);

        // Find existing processing media placeholder created by createCharacter
        const existingList = await db.media.findByWorkflow(workflowId).catch(() => []);
        const placeholder = existingList?.find((m) => m.step_id === targetStepId || m.status === "processing" || m.status === "pending");

        const width = output?.assets?.[0]?.width || resolvedInputs?.width || nodeConfig?.config?.width || 1344;
        const height = output?.assets?.[0]?.height || resolvedInputs?.height || nodeConfig?.config?.height || 768;

        if (placeholder?.id) {
          await db.media.updateMedia(placeholder.id, {
            url: mediaUrl,
            status: status || "completed",
            width,
            height,
          }).catch((err) => nodeLogger.warn({ workflowId, err }, `Failed to update media placeholder: ${err.message}`));
        } else {
          await db.media.createMedia({
            workflow_id: workflowId,
            project_id: projectId,
            step_id: targetStepId,
            url: mediaUrl,
            status: status || "completed",
            width,
            height,
          }).catch((err) => nodeLogger.warn({ workflowId, err }, `Failed to create media fallback: ${err.message}`));
        }
      }
    }
  } catch (err) {
    nodeLogger.warn({ nodeId: nodeConfig.id, err }, `Persistence notice for node ${nodeConfig.id}: ${err.message}`);
  }
}

/**
 * Safely extracts nested properties using dot notation paths.
 */
export function getValueAtPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let curr = obj;
  for (const part of parts) {
    if (curr === undefined || curr === null) return undefined;
    curr = curr[part];
  }
  return curr;
}

/**
 * Resolves input expressions for a node based on workflow inputs and dependency outputs.
 * Combines compiled static resolved_inputs and dynamic bindings expressions.
 */
export async function resolveInputsForNode(run, nodeConfig, nodeRuns) {
  const resolved = { ...(nodeConfig.resolved_inputs || {}) };
  const inputsToResolve = {
    ...(nodeConfig.user_inputs || {}),
    ...(nodeConfig.inputs || {}),
    ...(nodeConfig.bindings || {}),
  };

  for (const [key, expr] of Object.entries(inputsToResolve)) {
    if (typeof expr !== "string") {
      resolved[key] = expr;
      continue;
    }

    const parsed = parseBinding(expr);
    if (!parsed) {
      resolved[key] = expr;
      continue;
    }

    if (parsed.kind === "input") {
      const inputVal = run.input?.[parsed.field];
      if (inputVal !== undefined && inputVal !== null) {
        resolved[key] = inputVal;
      }
    } else if (parsed.kind === "node_output") {
      const depRun = nodeRuns.find((n) => n.node_id === parsed.nodeId);
      resolved[key] = getValueAtPath(depRun?.output, parsed.path);
    }
  }

  return resolved;
}

/**
 * Executes a single node directly without retries. On failure, immediately marks as failed.
 * @param {string} runId
 * @param {string} nodeId
 */
export async function executeNodeJob(runId, nodeId) {
  const startedAt = Date.now();
  
  // 1. Fetch current run and node run state
  const run = await runRepo.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} not found.`);
  }

  const nodeRun = await runRepo.getNodeRun(runId, nodeId);
  if (!nodeRun) {
    throw new Error(`Node run for ${runId}:${nodeId} not found.`);
  }

  // If node is already completed or failed, skip
  if (nodeRun.status === "completed" || nodeRun.status === "failed") {
    return;
  }

  const nodeConfig = run.execution_plan.nodes.find((n) => n.id === nodeId);
  if (!nodeConfig) {
    throw new Error(`Node configuration for ${nodeId} not found in execution plan.`);
  }

  // 2. Fetch other node runs to resolve dependencies
  const nodeRuns = await runRepo.listNodeRuns(runId);

  let placeholders = [];
  const isCoveredByUseCase = Boolean(run?.input?.billing_hold_id);
  let billingReservation = null;

  try {
    // 3. Resolve inputs
    const resolvedInputs = await resolveInputsForNode(run, nodeConfig, nodeRuns);

    nodeLogger.info(
      {
        nodeId,
        nodeType: nodeConfig.type,
        event: LogEvents.WORKFLOW_NODE_STARTED,
      },
      `Executing Node "${nodeId}" (${nodeConfig.type})`
    );
    nodeLogger.debug({ nodeId, inputs: resolvedInputs }, `Node "${nodeId}" inputs resolved`);

    // 4. Update status in database to running and set started_at if attempt is 1
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "running",
      started_at: nodeRun.started_at || new Date().toISOString()
    });

    const { eventRecorder } = getGateways();
    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: `node.start`,
        metadata: { nodeId, attempt: nodeRun.attempt }
      });
    }

    // 5. Invoke node execution
    const billing = getRunBillingAccumulator(runId);
    const ctx = {
      runId,
      nodeId,
      userId: run.user_id,
      traceId: runId,
      attempt: nodeRun.attempt,
      forceProvider: nodeRun.provider_override || null,
      billing,
    };

    if (isCoveredByUseCase) {
      // 🚀 IN-MEMORY BILLING ACCUMULATOR: Zero wallet touches during UseCase execution
      if (isProviderBackedNodeType(nodeConfig?.type)) {
        const nodeCost = estimateNodeBillingAmount(nodeConfig, resolvedInputs);
        ctx.billing?.record({
          nodeId,
          nodeType: nodeConfig.type,
          model: resolvedInputs.model,
          amount: nodeCost,
        });
      }
    } else {
      nodeLogger.debug({ nodeId }, `Reserving billing & preparing placeholders for Node "${nodeId}"`);
      billingReservation = await reserveNodeBilling({
        run,
        nodeConfig,
        resolvedInputs,
        attempt: nodeRun.attempt,
      });
    }

    nodeLogger.debug({ nodeId, nodeType: nodeConfig.type }, `Executing Processor "${nodeConfig.type}" for Node "${nodeId}"`);
    const output = await executeNode(nodeConfig.type, resolvedInputs, ctx);
    nodeLogger.debug({ nodeId }, `Persisting outputs for Node "${nodeId}"`);
    await executeNodePersistence({ nodeConfig, output, run, resolvedInputs });

    if (!isCoveredByUseCase && billingReservation) {
      await settleNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt, reservation: billingReservation });
    }

    const durationMs = Date.now() - startedAt;
    const envelope = nodeSuccess(output, {
      workflowRunId: runId,
      nodeRunId: nodeRun.id,
      nodeId,
      nodeType: nodeConfig.type,
      durationMs,
      modelKey: resolvedInputs.model,
      traceId: runId,
    });
    nodeLogger.info(
      {
        nodeId,
        durationMs,
        event: LogEvents.WORKFLOW_NODE_COMPLETED,
      },
      `Node "${nodeId}" COMPLETED successfully in ${durationMs}ms`
    );

    // 6. On success: update node status, complete it, and trigger orchestrator
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "completed",
      output: output && typeof output === "object"
        ? { ...output, __nodeEnvelope: envelope }
        : { value: output, __nodeEnvelope: envelope },
      completed_at: new Date().toISOString()
    });

    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: `node.complete`,
        durationMs,
        metadata: { nodeId, attempt: nodeRun.attempt }
      });
    }

  } catch (error) {
    nodeLogger.error(
      {
        nodeId,
        runId,
        err: error,
        event: LogEvents.WORKFLOW_NODE_FAILED,
      },
      `Node "${nodeId}" failed: ${error.message}`
    );

    if (!isCoveredByUseCase && billingReservation) {
      await rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt, reservation: billingReservation }).catch(() => {});
    }

    const maxAttempts = nodeConfig?.retry_policy?.max_attempts || 1;
    const currentAttempt = nodeRun?.attempt || 1;

    if (currentAttempt < maxAttempts && error?.retryable !== false) {
      const nextAttempt = currentAttempt + 1;
      const fallbackProvider = nodeConfig?.retry_policy?.fallback_provider || nodeRun.provider_override || null;
      nodeLogger.warn(
        {
          nodeId,
          runId,
          attempt: nextAttempt,
          maxAttempts,
          fallbackProvider,
        },
        `Retrying Node "${nodeId}" (Attempt ${nextAttempt}/${maxAttempts}) with fallback: ${fallbackProvider}`
      );

      await runRepo.updateNodeRun(runId, nodeId, {
        attempt: nextAttempt,
        status: "pending",
        provider_override: fallbackProvider,
      });

      return executeNodeJob(runId, nodeId);
    }

    const { storageGateway } = getGateways();
    if (storageGateway?.failPlaceholders && placeholders.length > 0) {
      await storageGateway.failPlaceholders(placeholders, error).catch(() => {});
    }

    const workflowId = run?.input?.workflow_id || run?.input?.characterId;
    if (workflowId) {
      const sanitized = formatWorkflowError(error);
      await db.media.findByWorkflow(workflowId).then((list) => {
        const p = list?.find((m) => m.status === "processing" || m.status === "pending");
        if (p?.id) return db.media.updateMedia(p.id, { status: "failed", error_message: sanitized.message }).catch(() => {});
      }).catch(() => {});
    }

    const { eventRecorder } = getGateways();
    if (eventRecorder) {
      eventRecorder.record({
        executionId: runId,
        traceId: runId,
        operation: `node.fail`,
        durationMs: Date.now() - startedAt,
        status: "error",
        errorCode: error.code || "NODE_FAILED",
        message: error.message,
        metadata: { nodeId, attempt: nodeRun.attempt }
      });
    }

    const envelope = nodeFailure(error, {
      workflowRunId: runId,
      nodeRunId: nodeRun.id,
      nodeId,
      nodeType: nodeConfig?.type,
      durationMs: Date.now() - startedAt,
      traceId: runId,
    });
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "failed",
      error: { code: error.code || "NODE_FAILED", message: error.message, envelope },
      completed_at: new Date().toISOString()
    });
  }
}
