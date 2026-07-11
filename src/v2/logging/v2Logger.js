/**
 * Structured logging for V2 workflow engine (Constitution IV minimum).
 * @param {{
 *   traceId: string,
 *   operation: string,
 *   durationMs: number,
 *   status: 'success' | 'error',
 *   errorCode?: string,
 *   message?: string,
 *   metadata?: Record<string, unknown>,
 * }} entry
 */
export function logV2Event(entry) {
  const payload = {
    timestamp: new Date().toISOString(),
    traceId: entry.traceId,
    operation: entry.operation,
    durationMs: entry.durationMs,
    status: entry.status,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.message ? { message: entry.message } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  };
  if (entry.status === "error") {
    console.error(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
}
