/**
 * Safe object serializers for request, response, provider, and error objects.
 * Prevents circular references and strips massive/sensitive internal state.
 */
import { sanitizeData } from "./redaction.js";

export function errSerializer(err) {
  if (!err) return err;
  if (typeof err === "string") return { message: err };

  return {
    type: err.name || err.constructor?.name || "Error",
    message: err.message,
    code: err.code || err.errorCode,
    statusCode: err.statusCode || err.status,
    stack: err.stack,
    ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
  };
}

export function reqSerializer(req) {
  if (!req) return req;

  const safeHeaders = {};
  if (req.headers && typeof req.headers === "object") {
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (lower === "authorization" || lower === "cookie" || lower === "x-api-key" || lower === "apikey" || lower === "x-internal-secret") {
        safeHeaders[k] = "[REDACTED]";
      } else {
        safeHeaders[k] = v;
      }
    }
  }

  return {
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.route?.path || req.path,
    query: req.query && Object.keys(req.query).length > 0 ? req.query : undefined,
    headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined,
    ip: req.ip || req.headers?.["x-forwarded-for"],
  };
}

export function resSerializer(res) {
  if (!res) return res;

  return {
    statusCode: res.statusCode,
  };
}

export function providerRequestSerializer(data) {
  return sanitizeData(data);
}
