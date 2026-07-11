import { randomUUID } from "node:crypto";
import { requireWorkflow } from "./workflowRegistry.js";
import { requireCapability } from "../capabilities/capabilityRegistry.js";
import { WORKFLOW_STATUSES, WORKFLOW_STEP_TYPES } from "./workflowConstants.js";
import { toSafeWorkflowError } from "./workflowErrors.js";

function now() {
  return new Date().toISOString();
}

export class WorkflowRunner {
  constructor({
    executionRepository,
    eventRecorder,
    billingGateway,
    storageGateway,
    queueGateway,
    treatmentDeps,
  }) {
    this.executionRepository = executionRepository;
    this.eventRecorder = eventRecorder;
    this.billingGateway = billingGateway;
    this.storageGateway = storageGateway;
    this.queueGateway = queueGateway;
    this.treatmentDeps = treatmentDeps;
  }

  async run({ workflowId, caller, input = {}, mode = "default", orchestrationContext = {}, async = false }) {
    const workflow = requireWorkflow(workflowId);
    const executionId = input.executionId || randomUUID();
    const traceId = caller?.traceId || randomUUID();
    const currentContext = { ...orchestrationContext, ...input, mode, userId: caller?.userId || input.userId || null };

    // Create V1 media placeholders at the very beginning of the run so the database/UI gets them immediately
    const placeholders = [];
    const capabilityStep = workflow.steps?.find(s => s.type === WORKFLOW_STEP_TYPES.CAPABILITY);
    if (capabilityStep && this.storageGateway) {
      const nodeType = capabilityStep.capabilityId;
      const count = currentContext.count || 1;
      const created = await this.storageGateway.startPlaceholders({
        userId: currentContext.userId || null,
        nodeType,
        input: currentContext,
        count,
        runId: executionId,
        workflowId: workflow.workflowId,
      });
      placeholders.push(...created);
    }
    
    currentContext._v1Placeholders = placeholders;

    const baseExecution = {
      executionId,
      workflowId,
      workflowVersion: workflow.version,
      callerType: caller?.type || "internal",
      userId: currentContext.userId,
      inputContext: input,
      currentContext,
      status: WORKFLOW_STATUSES.QUEUED,
      createdAt: now(),
      updatedAt: now(),
    };

    await this.executionRepository.create(baseExecution);
    this.eventRecorder.record({ executionId, traceId, operation: "workflow.request.start", status: "success" });

    if (async) {
      const job = await this.queueGateway.enqueueWorkflowJob("WorkflowArchitectureJob", {
        workflowId,
        executionId,
        caller,
        input,
        mode,
        orchestrationContext: currentContext,
      });
      await this.executionRepository.update(executionId, {
        jobReference: String(job.id),
        status: WORKFLOW_STATUSES.QUEUED,
      });
      this.eventRecorder.record({ executionId, traceId, operation: "workflow.queue", status: "success", metadata: { jobId: job.id } });
      return { executionId, status: WORKFLOW_STATUSES.QUEUED, jobReference: String(job.id), currentContext };
    }

    const completed = await this.executeRegisteredWorkflow({ workflow, executionId, traceId, context: baseExecution.currentContext });
    return completed;
  }

  async executeRegisteredWorkflow({ workflow, executionId, traceId, context }) {
    let currentContext = { ...context };
    let billingReferenceId = currentContext.billingReferenceId || `workflow:${executionId}`;
    let billingReserved = false;
    const placeholders = currentContext._v1Placeholders || [];

    try {
      await this.executionRepository.update(executionId, { status: WORKFLOW_STATUSES.PREPARING });
      this.eventRecorder.record({ executionId, traceId, operation: "workflow.prepare", status: "success" });

      if (currentContext.estimatedCost > 0) {
        await this.billingGateway.reserve({
          userId: currentContext.userId,
          amount: currentContext.estimatedCost,
          referenceId: billingReferenceId,
          metadata: { workflowId: workflow.workflowId, executionId },
        });
        billingReserved = true;
      }

      await this.executionRepository.update(executionId, { status: WORKFLOW_STATUSES.EXECUTING });

      for (const step of workflow.steps) {
        if (step.type === WORKFLOW_STEP_TYPES.PROCESSING_STEP) {
          currentContext = await this.executeProcessingStep({ step, currentContext, executionId, traceId });
        } else if (step.type === WORKFLOW_STEP_TYPES.CAPABILITY) {
          currentContext = await this.executeCapabilityStep({ step, currentContext, executionId, traceId });
        }
      }

      await this.executionRepository.update(executionId, { status: WORKFLOW_STATUSES.POST_PROCESSING, currentContext });
      
      const persistedAssets = [];
      if (placeholders.length > 0 && currentContext.mediaResults) {
        const assets = (currentContext.mediaResults || []).map(
          (mediaResult) => mediaResult.outputs?.[0] || mediaResult
        );
        const finalized = await this.storageGateway.completePlaceholders(
          placeholders,
          assets
        );
        for (const entry of finalized) {
          if (entry?.mediaId) {
            persistedAssets.push({
              id: entry.mediaId,
              workflowId: entry.workflowId,
              ...(entry.asset || {}),
            });
          }
        }
      } else {
        for (const mediaResult of currentContext.mediaResults || []) {
          persistedAssets.push(await this.storageGateway.persistMediaResult(mediaResult));
        }
      }

      if (billingReserved) {
        await this.billingGateway.settle(billingReferenceId);
        this.eventRecorder.record({ executionId, traceId, operation: "workflow.billing.settle", status: "success" });
      }

      const completed = await this.executionRepository.update(executionId, {
        status: WORKFLOW_STATUSES.COMPLETED,
        currentContext,
        mediaAssets: persistedAssets,
        completedAt: now(),
      });

      this.eventRecorder.record({ executionId, traceId, operation: "workflow.complete", status: "success" });
      return {
        executionId,
        status: WORKFLOW_STATUSES.COMPLETED,
        mediaAssets: persistedAssets,
        currentContext: completed.currentContext,
      };
    } catch (error) {
      console.error("❌ [WorkflowRunner] Execution error:", error);

      // Phase 2 (failure) — Mark all created placeholders as failed in the DB
      if (placeholders.length > 0) {
        await this.storageGateway
          .failPlaceholders(placeholders, error)
          .catch(() => null);
      }

      if (billingReserved) {
        await this.billingGateway.rollback(billingReferenceId).catch(() => null);
      }
      const safeError = toSafeWorkflowError(error);
      await this.executionRepository.update(executionId, {
        status: WORKFLOW_STATUSES.FAILED,
        error: safeError,
      });
      this.eventRecorder.record({
        executionId,
        traceId,
        operation: "workflow.failure",
        status: "error",
        errorCode: safeError.errorCode,
        message: safeError.message,
      });
      return { executionId, status: WORKFLOW_STATUSES.FAILED, error: safeError, currentContext };
    }
  }

  async executeProcessingStep({ step, currentContext, executionId, traceId }) {
    this.eventRecorder.record({ executionId, traceId, operation: `workflow.step.${step.stepId}`, status: "success" });

    if (!this.treatmentDeps) {
      return {
        ...currentContext,
        processingSteps: [...(currentContext.processingSteps || []), step.stepId],
      };
    }

    const { resolveProcessingStep } = await import("./processingStepRegistry.js");
    const resolvedDeps = typeof this.treatmentDeps === "function" ? this.treatmentDeps() : this.treatmentDeps;
    const treatment = resolveProcessingStep(step.stepId, resolvedDeps);

    if (typeof treatment.prepareContext === "function") {
      return treatment.prepareContext(currentContext, step.options || {});
    }

    return {
      ...currentContext,
      processingSteps: [...(currentContext.processingSteps || []), step.stepId],
    };
  }

  async executeCapabilityStep({ step, currentContext, executionId, traceId }) {
    const capability = requireCapability(step.capabilityId);
    this.eventRecorder.record({ executionId, traceId, operation: `workflow.capability.${step.capabilityId}`, status: "success" });

    if (typeof capability.execute !== "function") {
      return {
        ...currentContext,
        capabilities: [...(currentContext.capabilities || []), step.capabilityId],
      };
    }

    const output = await capability.execute({
      executionId,
      providerPolicy: step.providerPolicy || {},
      request: currentContext,
    });

    return {
      ...currentContext,
      capabilities: [...(currentContext.capabilities || []), step.capabilityId],
      providerDecisions: [...(currentContext.providerDecisions || []), output.decision],
      mediaResults: [...(currentContext.mediaResults || []), output.result],
    };
  }
}
