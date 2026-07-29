import { workflowRunner } from "../container.js";
import { requireWorkflow } from "./workflowRegistry.js";
import "./registerWorkflows.js";

export const WORKFLOW_ARCHITECTURE_JOB_TYPE = "WorkflowArchitectureJob";

export async function processWorkflowJob(payload) {
  const workflow = requireWorkflow(payload.workflowId);
  return workflowRunner.executeRegisteredWorkflow({
    workflow,
    executionId: payload.executionId,
    traceId: payload.caller?.traceId,
    context: {
      ...(payload.orchestrationContext || {}),
      ...(payload.input || {}),
      mode: payload.mode || "default",
      userId: payload.caller?.userId || payload.input?.userId || null,
    },
  });
}
