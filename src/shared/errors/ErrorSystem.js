import { ERROR_POLICY } from "./errorPolicy.js";
import { AppError } from "./AppError.js";

export const ErrorSystem = {
  process(err, context = {}, customLogger = null) {
    const isApp = err instanceof AppError;
    const code = isApp
      ? err.code
      : (typeof err === "object" && err?.code ? err.code : "INTERNAL_ERROR");
    const policy = ERROR_POLICY[code] ?? ERROR_POLICY.PROGRAMMER_ERROR;

    const report = {
      user: {
        code,
        category: policy.category,
        message: policy.userMessage,
        statusCode: policy.statusCode,
        retryable: policy.retryable,
        nodeId: context.nodeId,
      },
      system: {
        rawCode: code,
        rawMessage: err?.message || String(err),
        stack: err?.stack || null,
        type: isApp ? err.type : "PROGRAMMER",
        severity: policy.category === "SERVER_FAULT" ? "error" : "warn",
        nodeId: context.nodeId,
        traceId: context.runId || context.traceId,
        userId: context.userId,
        timestamp: new Date().toISOString(),
      },
      actions: {
        billingAction: policy.billingAction,
        shouldRefund: policy.billingAction !== "NONE",
        retryable: policy.retryable,
        statusCode: policy.statusCode,
      },
    };

    if (customLogger && typeof customLogger[report.system.severity] === "function") {
      customLogger[report.system.severity]({ ...report.system, msg: "error_processed" });
    }
    return report;
  },
};

export default ErrorSystem;
