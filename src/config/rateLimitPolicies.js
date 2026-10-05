/**
 * Centralized Rate Limit Policies
 * ─────────────────────────────────────────────────────────────────────────────
 * Each policy controls:
 *   points   — max requests allowed in the duration window
 *   duration — window length in seconds
 *   keyBy    — "user" (req.user.id) or "ip" (req.ip)
 *
 * Store (per process):
 *   V1: memory — counters lost on restart, acceptable for single-process.
 *   V2: set RATE_LIMIT_STORE=redis to share counters across processes/replicas
 *       without changing any route or policy code.
 *
 * ⚠️  MULTI-PROCESS NOTE:
 *   Memory store is per-process. With PM2 cluster / Docker replicas / k8s pods,
 *   each process has an independent counter. To enforce global limits across
 *   all instances, switch to Redis store (RATE_LIMIT_STORE=redis).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const RATE_LIMIT_POLICIES = {
  /** POST /api/images/generated */
  imageGeneration: {
    points:   20,   // 20 requests
    duration: 60,   // per 60 seconds
    keyBy:    "user",
  },

  /** POST /api/video/generated */
  videoGeneration: {
    points:   5,    // 5 requests
    duration: 60,   // per 60 seconds
    keyBy:    "user",
  },

  /** POST /api/auth/login (unauthenticated — key by IP) */
  login: {
    points:   5,    // 5 attempts
    duration: 300,  // per 5 minutes
    keyBy:    "ip",
  },

  /** POST /api/prompt/optimize */
  promptOptimization: {
    points:   30,   // 30 requests
    duration: 60,   // per 60 seconds
    keyBy:    "user",
  },

  /** POST /api/characters/generate-description (configurable, default 10/min) */
  characterDescription: {
    points:   Number(process.env.RATE_LIMIT_CHARACTER_DESC_POINTS) || 10,
    duration: Number(process.env.RATE_LIMIT_CHARACTER_DESC_DURATION) || 60,
    keyBy:    "user",
  },

  /** POST /api/v2/elements/analyze (configurable, default 10/min) */
  elementAnalysis: {
    points:   Number(process.env.RATE_LIMIT_ELEMENT_ANALYZE_POINTS) || 10,
    duration: Number(process.env.RATE_LIMIT_ELEMENT_ANALYZE_DURATION) || 60,
    keyBy:    "user",
  },
};
