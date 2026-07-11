/**
 * Resolves whether a node should be retried and if a fallback provider is needed.
 * @param {import('../contracts/executionGraph.js').ExecutionGraphNode} node
 * @param {number} attempt Current 1-based attempt number
 * @returns {{ shouldRetry: boolean, nextAttempt?: number, providerOverride?: string }}
 */
export function resolveRetryAttempt(node, attempt) {
  const maxAttempts = node.retry_policy?.max_attempts || 1;
  const hasFallback = !!node.retry_policy?.fallback_provider;

  if (attempt >= maxAttempts) {
    return { shouldRetry: false };
  }

  const nextAttempt = attempt + 1;
  const isFinalAttempt = nextAttempt === maxAttempts;

  return {
    shouldRetry: true,
    nextAttempt,
    providerOverride: (isFinalAttempt && hasFallback) ? node.retry_policy.fallback_provider : undefined
  };
}

/**
 * Calculates backoff delay in milliseconds.
 * @param {import('../contracts/executionGraph.js').RetryPolicy} retryPolicy
 * @param {number} attempt The attempt that just failed (1-based)
 * @returns {number} Delay in milliseconds
 */
export function getBackoffDelay(retryPolicy, attempt) {
  const strategy = retryPolicy?.backoff || "none";
  if (strategy === "none") return 0;
  
  const baseDelayMs = 1000;
  if (strategy === "linear") {
    return attempt * baseDelayMs;
  }
  if (strategy === "exponential") {
    return Math.pow(2, attempt) * baseDelayMs;
  }
  return 0;
}
