/**
 * safePublicRouteError
 * Maps a caught route error onto the public API error contract.
 *
 * Rule (single source for all upload/media routes):
 * - Internal failures (5xx) are masked: the client only sees
 *   "Internal server error" + errorCode INTERNAL_ERROR.
 * - 4xx messages are intentional public contract and keep their
 *   message and errorCode (including CrudServiceError passthrough).
 *
 * @param {Object} err
 * @param {{ statusCode?: number }} [overrides] - explicit statusCode derivation
 *   handed over by call sites that own their own fallback rule
 *   (e.g. INSUFFICIENT_CREDITS -> 402). Omitted: err.statusCode || 500.
 * @returns {{ statusCode: number, errorCode: string, publicMessage: string }}
 */
export function safePublicRouteError(err, { statusCode } = {}) {
    const resolvedStatusCode = statusCode ?? (err.statusCode || 500);
    const isInternal = resolvedStatusCode >= 500;
    const errorCode = isInternal
        ? "INTERNAL_ERROR"
        : (err.errorCode || (resolvedStatusCode === 404 ? "NOT_FOUND" : "APP_ERROR"));
    return {
        statusCode: resolvedStatusCode,
        errorCode,
        publicMessage: isInternal ? "Internal server error" : err.message,
    };
}
