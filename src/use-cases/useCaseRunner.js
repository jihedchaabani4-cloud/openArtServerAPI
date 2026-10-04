import { getUseCase } from "./useCaseRegistry.js";
import { compileWorkflowById } from "../v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../v2/runner/workflowRunner.js";
import { loadRegistries } from "../v2/registry/registryLoader.js";
import { createLogger, LogEvents } from "../infrastructure/logging/index.js";

const useCaseLogger = createLogger("usecase");

let cachedRegistries = null;
export function getRegistries() {
  if (process.env.NODE_ENV !== "production") {
    return loadRegistries();
  }
  if (!cachedRegistries) {
    cachedRegistries = loadRegistries();
  }
  return cachedRegistries;
}

/**
 * Orchestrates Use Case execution lifecycle (called from Worker).
 * Compile workflow → startWorkflowRun (DB + orchestration).
 */
export async function run({
  useCaseId,
  input = {},
  userId,
  registries = null,
}) {
  useCaseLogger.debug({ useCaseId, userId }, `Starting Use Case execution: "${useCaseId}"`);

  // 1. Resolve Use Case
  const useCase = getUseCase(useCaseId);
  if (!useCase) {
    useCaseLogger.error({ useCaseId }, `Use Case "${useCaseId}" not found`);
    const err = new Error(`Use Case "${useCaseId}" not found`);
    err.statusCode = 404;
    err.code = "USE_CASE_NOT_FOUND";
    throw err;
  }

  // 2. Resolve registries
  const finalRegistries = registries || getRegistries();

  // 4. Compile V2 workflow
  if (!finalRegistries?.workflows?.[useCase.workflowRef]) {
    const err = new Error(`Associated workflow "${useCase.workflowRef}" not found in registries`);
    err.statusCode = 404;
    err.code = "WORKFLOW_NOT_FOUND";
    throw err;
  }

  let plan;
  try {
    plan = compileWorkflowById(useCase.workflowRef, finalRegistries);
    useCaseLogger.debug({ workflowRef: useCase.workflowRef }, `Workflow compiled: ${useCase.workflowRef}`);
  } catch (compilationErr) {
    const err = new Error(`Workflow compilation failed: ${compilationErr.message}`);
    err.statusCode = 422;
    err.code = "COMPILATION_FAILED";
    err.errors = compilationErr.errors || [];
    throw err;
  }

  // 5. Start workflow run (creates DB records + enqueues nodes)
  const serverWorkflowId = input.serverWorkflowId || input.workflow_id || null;
  const serverMediaIds = input.serverMediaIds || (input.media_id ? [input.media_id] : (input.mediaIds || []));
  const serverProjectId = input.serverProjectId || input.project_id || input.projectId || null;
  const serverContext = {
    workflowId: serverWorkflowId,
    v1_workflow_id: serverWorkflowId,
    mediaIds: serverMediaIds,
    projectId: serverProjectId,
  };
  const runtimeInput = { ...input, userId, serverWorkflowId, serverMediaIds, serverProjectId };
  useCaseLogger.debug({ workflowRef: useCase.workflowRef }, "Dispatching to V2 Engine...");
  const runResult = await startWorkflowRun(plan, runtimeInput, null, serverContext);

  if (runResult.status !== "completed") {
    useCaseLogger.error({ runId: runResult.run_id, err: runResult.error, status: runResult.status }, `Workflow Run ${runResult.run_id} failed with status "${runResult.status}": ${runResult.error?.message || "Incomplete execution"}`);
    const err = new Error(runResult.error?.message || `Workflow "${useCase.workflowRef}" failed with status: ${runResult.status}`);
    err.code = runResult.error?.code || (runResult.status === "failed" ? "WORKFLOW_FAILED" : "WORKFLOW_INCOMPLETE");
    err.category = runResult.error?.category || "SERVER_FAULT";
    err.userMessage = runResult.error?.message || `Execution did not complete (status: ${runResult.status})`;
    err.nodeId = runResult.error?.nodeId || null;
    err.retryable = runResult.error?.retryable ?? false;
    err.executionId = runResult.run_id;
    err.billingBreakdown = runResult.billingBreakdown || [];
    throw err;
  }

  useCaseLogger.info({ runId: runResult.run_id, status: runResult.status }, `Workflow Run ${runResult.run_id} completed with status: ${runResult.status}`);

  return {
    executionId: runResult.run_id,
    status: runResult.status,
    outputs: runResult.outputs || null,
    billingBreakdown: runResult.billingBreakdown || [],
    totalCost: runResult.totalCost ?? 0,
  };
}
