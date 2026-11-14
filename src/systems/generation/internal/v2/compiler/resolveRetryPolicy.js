/**
 * @param {import('../contracts/executionGraph.js').RetryPolicy} defaultPolicy
 * @param {boolean} skillAware
 * @param {{ network: boolean }[]} resolvedProcessors
 * @returns {import('../contracts/executionGraph.js').RetryPolicy}
 */
export function resolveRetryPolicy(defaultPolicy = {}, skillAware = false, resolvedProcessors = []) {
  const policy = {
    max_attempts: defaultPolicy.max_attempts ?? 1,
    backoff: defaultPolicy.backoff ?? "none",
  };

  return policy;
}
