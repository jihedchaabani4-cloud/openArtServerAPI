export const MODEL_EVENTS = Object.freeze({
  VALIDATION_FAILED: "models.validation.failed",
  DEPLOYMENT_RESOLVED: "models.deployment.resolved",
  DEPLOYMENT_UNAVAILABLE: "models.deployment.unavailable",
  PRICING_CALCULATED: "models.pricing.calculated",
  EXECUTION_STARTED: "models.execution.started",
  EXECUTION_SUCCEEDED: "models.execution.succeeded",
  EXECUTION_FAILED: "models.execution.failed",
  IDEMPOTENT_REPLAY: "models.execution.idempotent_replay",
});

class TelemetryService {
  constructor() {
    this.emitter = null;
    this.logger = null;
  }

  init({ eventEmitter = null, logger = null } = {}) {
    this.emitter = eventEmitter;
    this.logger = logger;
  }

  emit(eventName, payload = {}) {
    if (!this.emitter && !this.logger) return;

    const safePayload = {
      ...payload,
      timestamp: new Date().toISOString(),
    };

    if (this.emitter && typeof this.emitter.emit === "function") {
      try {
        this.emitter.emit(eventName, safePayload);
      } catch {
        // Drop emitter error silently to avoid breaking execution
      }
    }

    if (this.logger && typeof this.logger.info === "function") {
      try {
        if (eventName.endsWith(".failed") || eventName.endsWith(".unavailable")) {
          if (typeof this.logger.warn === "function") {
            this.logger.warn(`[Models] ${eventName}`, safePayload);
          } else {
            this.logger.info(`[Models] ${eventName}`, safePayload);
          }
        } else {
          this.logger.info(`[Models] ${eventName}`, safePayload);
        }
      } catch {
        // Drop logger error silently
      }
    }
  }
}

export const telemetry = new TelemetryService();
export default telemetry;
