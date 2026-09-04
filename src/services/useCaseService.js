import { randomUUID } from "node:crypto";
import { getUseCase, listUseCases } from "../use-cases/useCaseRegistry.js";
import { compileWorkflowById } from "../v2/compiler/compileWorkflow.js";
import { loadRegistries } from "../v2/registry/registryLoader.js";
import { UseCaseBillingRuntime } from "../v2/runtime/useCaseBillingRuntime.js";
import { calculateWorkflowBillingPlan } from "../use-cases/workflowBillingPlan.js";
import { ErrorSystem } from "../runtime/ErrorSystem.js";
import { jobQueueService as defaultJobQueueService } from "./jobQueueService.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const useCaseLogger = createLogger("usecase");

function validateUseCaseInputs(input = {}, schema = {}) {
  for (const [key, fieldConfig] of Object.entries(schema)) {
    const val = input[key];
    if (fieldConfig.required && (val === undefined || val === null || val === "")) {
      const err = new Error(`Missing required field: "${key}"`);
      err.statusCode = 400;
      err.code = "INVALID_INPUT";
      throw err;
    }
    if (val === undefined || val === null || val === "") continue;
    if (fieldConfig.type === "number" && Number.isNaN(Number(val))) {
      const err = new Error(`Field "${key}" must be a number`);
      err.statusCode = 400;
      err.code = "INVALID_INPUT";
      throw err;
    }
    if (fieldConfig.type === "enum" && Array.isArray(fieldConfig.options) && !fieldConfig.options.includes(val)) {
      const err = new Error(`Field "${key}" must be one of: ${fieldConfig.options.join(", ")}`);
      err.statusCode = 400;
      err.code = "INVALID_INPUT";
      throw err;
    }
  }
}

function getRegistriesForPrepare() {
  return loadRegistries();
}

/**
 * Unified UseCase Service
 * Canonical entry point for all business UseCase operations and execution.
 */
export class UseCaseService {
  constructor({
    walletService = null,
    pricingService = null,
    jobQueueService = null,
    billingRuntime = null,
  } = {}) {
    this.walletService = walletService;
    this.pricingService = pricingService;
    this.jobQueueService = jobQueueService || defaultJobQueueService;
    this.billingRuntime = billingRuntime || new UseCaseBillingRuntime({ walletService });
  }

  /**
   * Validate, compile, calculate upfront cost, reserve credits, then enqueue.
   * This is the canonical paid UseCase entrypoint for HTTP controllers.
   */
  async prepareAndEnqueue({
    useCaseId,
    input = {},
    userId,
    idempotencyKey = null,
    traceId = null,
    executionId = null,
    jobQueueService = null,
  }) {
    const started = Date.now();
    const useCase = getUseCase(useCaseId);
    if (!useCase) {
      const err = new Error(`Use Case "${useCaseId}" not found`);
      err.statusCode = 404;
      err.code = "USE_CASE_NOT_FOUND";
      throw err;
    }

    validateUseCaseInputs(input, useCase.inputSchema);

    const registries = getRegistriesForPrepare();
    const plan = compileWorkflowById(useCase.workflowRef, registries);
    const finalExecutionId = executionId || input.workflow_id || randomUUID();
    const finalTraceId = traceId || finalExecutionId;
    const finalIdempotencyKey = idempotencyKey || `usecase:${useCaseId}:${userId}:${finalExecutionId}`;

    const billingPlan = await calculateWorkflowBillingPlan({
      plan,
      inputs: input,
    });


    const reserve = await this.billingRuntime.reserveUseCase({
      userId,
      useCaseId,
      workflowRunId: finalExecutionId,
      totalCredits: billingPlan.totalCredits,
      costBreakdown: billingPlan,
      idempotencyKey: finalIdempotencyKey,
    });

    const queue = jobQueueService || this.jobQueueService;
    const job = await queue.addUseCaseJob({
      useCaseId,
      input: {
        ...input,
        billing_hold_id: reserve.billingHoldId,
        billing_status: reserve.billingStatus,
        reserved_credits: reserve.reservedCredits,
      },
      userId,
      executionId: finalExecutionId,
      workflowRunId: finalExecutionId,
      billingHoldId: reserve.billingHoldId,
      idempotencyKey: finalIdempotencyKey,
      traceId: finalTraceId,
    });

    useCaseLogger.info(
      {
        event: LogEvents.USECASE_STARTED,
        useCaseId,
        jobId: job?.id,
        workflowRunId: finalExecutionId,
        reservedCredits: reserve.reservedCredits,
        durationMs: Date.now() - started,
      },
      `UseCase "${useCaseId}" prepared and enqueued (${Date.now() - started}ms)`
    );

    return {
      status: "queued",
      workflowRunId: finalExecutionId,
      executionId: finalExecutionId,
      jobId: job?.id,
      billingHoldId: reserve.billingHoldId,
      cost: {
        totalCredits: billingPlan.totalCredits,
        currency: "credits",
        components: billingPlan.billableNodes,
      },
      billing: reserve,
      plan,
    };
  }

  assertPaidJobHasHold({ useCaseId, input = {}, billingHoldId = null } = {}) {
    const reservedCredits = Number(input.reserved_credits || input.reservedCredits || 0);
    const holdId = billingHoldId || input.billing_hold_id || input.billingHoldId || null;
    const isPaid = reservedCredits > 0 || input.billing_status === "reserved";

    if (isPaid && !holdId) {
      const err = new Error(`Paid UseCase "${useCaseId}" is missing billing hold.`);
      err.code = "BILLING_HOLD_REQUIRED";
      err.statusCode = 402;
      throw err;
    }

    return { paid: isPaid, billingHoldId: holdId, reservedCredits };
  }

  async settlePreparedBilling(referenceId, extraMetadata = null) {
    return this.billingRuntime.settleUseCase(referenceId, extraMetadata);
  }

  async rollbackPreparedBilling(referenceId, extraMetadata = null) {
    return this.billingRuntime.rollbackUseCase(referenceId, extraMetadata);
  }

  async executeQueuedUseCase({ useCaseId, input = {}, userId, billingHoldId = null, traceId = null }) {
    const started = Date.now();
    const effectiveTraceId = traceId || input.traceId || input.billing_hold_id || randomUUID();
    const guard = this.assertPaidJobHasHold({ useCaseId, input, billingHoldId });

    useCaseLogger.info(
      {
        event: LogEvents.USECASE_STARTED,
        useCaseId,
        billingHoldId: guard.billingHoldId,
      },
      `Starting execution of UseCase "${useCaseId}"`
    );

    try {
      const result = await this.runUseCase({ useCaseId, input, userId });
      if (guard.paid) {
        await this.settlePreparedBilling(guard.billingHoldId, {
          node_breakdown: result?.billingBreakdown || [],
          totalCost: result?.totalCost,
        });
      }
      const durationMs = Date.now() - started;
      useCaseLogger.info(
        {
          event: LogEvents.USECASE_COMPLETED,
          useCaseId,
          durationMs,
          settled: guard.paid,
        },
        `UseCase "${useCaseId}" completed successfully in ${durationMs}ms`
      );
      return result;
    } catch (err) {
      const report = ErrorSystem.process(err, {
        runId: effectiveTraceId,
        userId,
        nodeId: err?.nodeId,
      });
      err.errorReport = report;

      if (guard.paid && (report.actions.billingAction === "ROLLBACK" || report.actions.billingAction === "RELEASE")) {
        await this.rollbackPreparedBilling(guard.billingHoldId, {
          node_breakdown: err?.billingBreakdown || [],
          failedMessage: report.system.rawMessage,
          errorCategory: report.user.category,
          errorCode: report.user.code,
          userMessage: report.user.message,
        }).catch(() => {});
      }

      if (input?.workflow_id && this.db?.media) {
        await this.db.media.findByWorkflow(input.workflow_id).then((list) => {
          const p = list?.find((m) => m.status === "processing" || m.status === "pending");
          if (p?.id) {
            return this.db.media.updateMedia(p.id, {
              status: "failed",
              error_message: report.user.message,
            }).catch(() => {});
          }
        }).catch(() => {});
      }
      useCaseLogger.error({
        event: LogEvents.USECASE_FAILED,
        useCaseId,
        errorCode: report.user.code,
        category: report.user.category,
        durationMs: Date.now() - started,
        err,
      }, `UseCase "${useCaseId}" failed [${report.user.category}]: ${report.user.message}`);
      throw err;
    }
  }

  /**
   * Execute a UseCase workflow from start to finish.
   * @param {Object} params
   * @param {string} params.useCaseId
   * @param {Object} params.input
   * @param {string} params.userId
   * @param {Object} [params.walletService]
   * @param {Object} [params.pricingService]
   * @returns {Promise<{ executionId: string, status: string, totalCost: number }>}
   */
  async runUseCase({ useCaseId, input, userId }) {
    const { run: executeUseCase } = await import("../use-cases/useCaseRunner.js");
    return executeUseCase({ useCaseId, input, userId });
  }

  /**
   * Get UseCase definition by ID.
   * @param {string} useCaseId
   */
  getUseCase(useCaseId) {
    return getUseCase(useCaseId);
  }

  /**
   * List all available UseCases.
   */
  listUseCases() {
    return listUseCases();
  }
}
