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
 * @returns {{ statusCode: number, errorCode: string, publicMessage: string }}
 */
export function safePublicRouteError(err) {
    const statusCode = err.statusCode || 500;
    const isInternal = statusCode >= 500;
    const errorCode = isInternal
        ? "INTERNAL_ERROR"
        : (err.errorCode || (statusCode === 404 ? "NOT_FOUND" : "APP_ERROR"));
    return {
        statusCode,
        errorCode,
        publicMessage: isInternal ? "Internal server error" : err.message,
    };
}
