function toPositiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return toPositiveNumber(raw, fallback);
}

function normalizeType(type) {
  return String(type || "generic").trim().toUpperCase();
}

function normalizeKeyPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function envCandidates(context = {}) {
  const type = normalizeType(context.type);
  const provider = normalizeKeyPart(context.provider);
  const model = normalizeKeyPart(context.model);

  const candidates = [];
  if (type && provider && model) candidates.push(`${type}_${provider}_${model}`);
  if (type && provider) candidates.push(`${type}_${provider}`);
  if (type) candidates.push(type);
  candidates.push("GENERIC");
  return candidates;
}

function readPolicyValue(prefixes, suffix, fallback) {
  for (const prefix of prefixes) {
    const value = getEnvNumber(`${prefix}_${suffix}`, null);
    if (value != null) return value;
  }
  return fallback;
}

function buildDefaultPolicy(context = {}) {
  const prefixes = envCandidates(context);
  const isVideo = normalizeType(context.type) === "VIDEO";

  return {
    requestTimeoutMs: readPolicyValue(prefixes, "REQUEST_TIMEOUT_MS", isVideo ? 120000 : 30000),
    pollTimeoutMs: readPolicyValue(prefixes, "POLL_TIMEOUT_MS", 10000),
    pollIntervalMs: readPolicyValue(prefixes, "POLL_INTERVAL_MS", 3000),
    maxDurationMs: readPolicyValue(prefixes, "MAX_DURATION_MS", isVideo ? 300000 : 600000),
  };
}

export function resolveExecutionPolicy(payload = {}, context = {}) {
  const defaults = buildDefaultPolicy(context);

  return {
    ...defaults,
    requestTimeoutMs: toPositiveNumber(payload.requestTimeoutMs, defaults.requestTimeoutMs),
    pollTimeoutMs: toPositiveNumber(payload.pollTimeoutMs, defaults.pollTimeoutMs),
    pollIntervalMs: toPositiveNumber(payload.pollIntervalMs, defaults.pollIntervalMs),
    maxDurationMs: toPositiveNumber(payload.maxDurationMs, defaults.maxDurationMs),
  };
}
