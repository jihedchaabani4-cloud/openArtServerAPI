function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function createTimeoutSignal(ms) {
  const timeoutMs = toPositiveNumber(ms);
  if (!timeoutMs) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

export function sleep(ms) {
  const delayMs = toPositiveNumber(ms) ?? 0;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function normalizeFetchOptions(options = {}) {
  const { timeoutMs, signal, ...rest } = options;
  return {
    ...rest,
    ...(signal ? { signal } : {}),
    ...(timeoutMs ? { signal: createTimeoutSignal(timeoutMs) } : {}),
  };
}
