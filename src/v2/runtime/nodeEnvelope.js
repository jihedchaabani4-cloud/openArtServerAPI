import { NODE_STATUS } from "./runtimeConstants.js";
import { toRuntimeError } from "./errorPolicy.js";

function baseMetadata(metadata = {}) {
  return {
    workflowRunId: metadata.workflowRunId || metadata.runId || null,
    nodeRunId: metadata.nodeRunId || null,
    nodeId: metadata.nodeId || null,
    nodeType: metadata.nodeType || null,
    durationMs: Math.max(0, Number(metadata.durationMs) || 0),
    provider: metadata.provider,
    modelKey: metadata.modelKey,
    costCredits: metadata.costCredits,
    traceId: metadata.traceId,
  };
}

export function nodeSuccess(data = {}, metadata = {}) {
  return {
    success: true,
    status: NODE_STATUS.COMPLETED,
    data,
    error: null,
    metadata: baseMetadata(metadata),
  };
}

export function nodeFailure(error, metadata = {}) {
  return {
    success: false,
    status: NODE_STATUS.FAILED,
    data: null,
    error: toRuntimeError(error),
    metadata: baseMetadata(metadata),
  };
}

export function fromNodeResult(result, metadata = {}) {
  if (result?.success === false || result?.status === NODE_STATUS.FAILED) {
    return nodeFailure(result.error || result, { ...metadata, ...result.metadata });
  }
  return nodeSuccess(result?.data ?? result ?? {}, { ...metadata, ...result?.metadata });
}
