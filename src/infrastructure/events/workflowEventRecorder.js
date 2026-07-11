import { randomUUID } from "node:crypto";

export class WorkflowEventRecorder {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.events = [];
  }

  record(event) {
    const normalized = {
      eventId: event.eventId || randomUUID(),
      executionId: event.executionId || null,
      traceId: event.traceId || null,
      operation: event.operation,
      status: event.status || "success",
      durationMs: event.durationMs ?? null,
      errorCode: event.errorCode || null,
      message: event.message || null,
      metadata: event.metadata || {},
      createdAt: event.createdAt || new Date().toISOString(),
    };

    this.events.push(normalized);
    this.logger.info?.("[WorkflowEvent]", normalized);
    return normalized;
  }

  list() {
    return [...this.events];
  }
}
