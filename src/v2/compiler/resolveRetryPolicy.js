/**
 * @param {import('../contracts/executionGraph.js').RetryPolicy} defaultPolicy
 * @param {boolean} skillAware
 * @param {{ network: boolean }[]} resolvedProcessors
 * @returns {import('../contracts/executionGraph.js').RetryPolicy}
 */
export function resolveRetryPolicy(defaultPolicy, skillAware, resolvedProcessors) {
  const policy = {
    max_attempts: defaultPolicy.max_attempts,
    backoff: defaultPolicy.backoff,
    ...(defaultPolicy.fallback_provider ? { fallback_provider: defaultPolicy.fallback_provider } : {}),
  };

  const hasNetworkProcessor =
    skillAware && resolvedProcessors.some((processor) => processor.network === true);

  if (hasNetworkProcessor) {
    policy.max_attempts = Math.max(2, policy.max_attempts);
    if (policy.backoff === "none") {
      policy.backoff = "linear";
    }
  }

  return policy;
}
