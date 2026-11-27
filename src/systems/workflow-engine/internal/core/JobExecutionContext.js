import { randomUUID } from "node:crypto";

/**
 * JobExecutionContext (Standalone Workflow Engine Core)
 *
 * Isolated per-run runtime context owning:
 * - Frozen `identity` (`executionId`, `runId`, `jobId`, `userId`, `blueprintId`, `workflowId`)
 * - Mutable lifecycle `state` (`created` -> `running` -> `completed` | `failed`)
 * - Per-run `cache` (`Map`) cleared on `dispose()`
 */
export class JobExecutionContext {
  constructor({
    executionId = null,
    runId = null,
    jobId = null,
    userId = null,
    blueprintId = null,
    workflowId = null,
  } = {}) {
    const resolvedExecutionId = executionId || runId || randomUUID();
    const resolvedRunId = runId || resolvedExecutionId;

    this.identity = Object.freeze({
      executionId: resolvedExecutionId,
      runId: resolvedRunId,
      jobId: jobId || null,
      userId: userId || null,
      blueprintId: blueprintId || null,
      workflowId: workflowId || null,
    });

    this.state = {
      status: "created",
      startedAt: null,
      finishedAt: null,
      error: null,
    };

    this.cache = new Map();
  }

  markRunning() {
    this.state.status = "running";
    if (!this.state.startedAt) {
      this.state.startedAt = new Date().toISOString();
    }
    return this.state;
  }

  markCompleted() {
    this.state.status = "completed";
    this.state.finishedAt = new Date().toISOString();
    this.state.error = null;
    return this.state;
  }

  markFailed(err = null) {
    this.state.status = "failed";
    this.state.finishedAt = new Date().toISOString();
    this.state.error = err ?? null;
    return this.state;
  }

  dispose() {
    this.cache.clear();
  }
}

export function createJobExecutionContext(options = {}) {
  return new JobExecutionContext(options);
}

export default JobExecutionContext;
