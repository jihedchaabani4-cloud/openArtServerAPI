import { randomUUID } from "node:crypto";
import { workflowRunner, workflowStatusService } from "../src/container.js";
import { resolveFeatureWorkflowRequest } from "../src/workflows/featureWorkflowResolver.js";
import { normalizeWorkflowRunInput, normalizeWorkflowRunResult } from "../src/workflows/workflowRunContract.js";
import { toSafeWorkflowError } from "../src/workflows/workflowErrors.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";

export async function startWorkflow(req, res) {
  try {
    const { featureId, mode = "default", input = {}, clientRequestId = null, async = true } = req.body || {};
    
    const userId = req.user?.id || input.userId || null;
    let projectId = input.project_id;
    let sessionId = input.session_id;
    
    if (userId) {
      const ensured = await autoCreateProjectAndSession(userId, projectId, sessionId);
      projectId = ensured.project_id;
      sessionId = ensured.session_id;
    }

    const resolution = resolveFeatureWorkflowRequest({
      featureId,
      mode,
      allowDisabled: true, // Allow execution of registered migration slices
    });

    const runInput = normalizeWorkflowRunInput({
      workflowId: resolution.workflowId,
      mode: resolution.mode,
      async,
      caller: {
        type: "http",
        traceId: req.headers["x-trace-id"] || clientRequestId || randomUUID(),
        userId,
      },
      input: {
        ...input,
        project_id: projectId,
        session_id: sessionId,
        featureId,
        clientRequestId,
      },
    });

    const rawResult = await workflowRunner.run(runInput);
    const result = normalizeWorkflowRunResult(rawResult);
    const statusCode = result.status === "queued" ? 202 : 200;

    // Extract legacy-compatible fields from the first mediaResult or placeholder
    // so the frontend can use project_id / session_id / jobId without changes.
    const firstMediaResult = result.mediaAssets?.[0] 
                          ?? result.currentContext?.mediaResults?.[0] 
                          ?? result.currentContext?._v1Placeholders?.[0] 
                          ?? {};
                          
    const legacyFields = {
      project_id:  result.currentContext?.project_id ?? input.project_id ?? null,
      session_id:  result.currentContext?.session_id ?? input.session_id ?? null,
      batchId:     firstMediaResult.batchId  ?? result.currentContext?.batchId  ?? null,
      configId:    firstMediaResult.configId ?? result.currentContext?.configId ?? null,
      jobId:       firstMediaResult.jobId    ?? result.currentContext?.jobId    ?? null,
      taskId:      firstMediaResult.jobId    ?? result.currentContext?.jobId    ?? null,
      workflows:   firstMediaResult.workflows ?? result.currentContext?.workflows ?? (firstMediaResult.workflowId ? [{ id: firstMediaResult.workflowId }] : []),
      mediaAssets: firstMediaResult.mediaId ? [{ id: firstMediaResult.mediaId }] : [],
      balance:     firstMediaResult.balance   ?? result.currentContext?.balance   ?? null,
      workflowId:  firstMediaResult.workflowId ?? null,
      mediaId:     firstMediaResult.mediaId ?? null,
    };

    return res.status(statusCode).json({
      ok: true,
      ...result,
      ...legacyFields,
      statusUrl: `/api/workflow-architecture/${result.executionId}`,
    });
  } catch (error) {
    const safeError = toSafeWorkflowError(error);
    return res.status(error.code === "FEATURE_DISABLED" ? 409 : 400).json({
      error: {
        errorCode: safeError.errorCode,
        message: safeError.message,
      },
    });
  }
}

export async function getWorkflowStatus(req, res) {
  const status = await workflowStatusService.getStatus(req.params.executionId);
  if (status.error) {
    return res.status(404).json(status);
  }
  return res.json(status);
}
