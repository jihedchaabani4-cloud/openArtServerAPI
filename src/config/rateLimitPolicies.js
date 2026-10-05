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
    points:     20,   // 20 requests
    duration:   60,   // per 60 seconds
    keyBy:      "user",
    failPolicy: "close",
  },

  /** POST /api/video/generated */
  videoGeneration: {
    points:     5,    // 5 requests
    duration:   60,   // per 60 seconds
    keyBy:      "user",
    failPolicy: "close",
  },

  /** POST /api/auth/login (10 per 5 min per IP) */
  loginIp: {
    points:     Number(process.env.RATE_LIMIT_LOGIN_IP_POINTS) || 10,
    duration:   Number(process.env.RATE_LIMIT_LOGIN_IP_DURATION) || 300,  // 5 minutes
    keyBy:      "ip",
    failPolicy: "insurance",
  },

  /** POST /api/auth/login (5 per 15 min per email) */
  loginEmail: {
    points:     Number(process.env.RATE_LIMIT_LOGIN_EMAIL_POINTS) || 5,
    duration:   Number(process.env.RATE_LIMIT_LOGIN_EMAIL_DURATION) || 900,  // 15 minutes
    keyBy:      "email",
    failPolicy: "insurance",
  },

  /** POST /api/auth/signup (10 per hour per IP) */
  signupIp: {
    points:     Number(process.env.RATE_LIMIT_SIGNUP_IP_POINTS) || 10,
    duration:   Number(process.env.RATE_LIMIT_SIGNUP_IP_DURATION) || 3600, // 1 hour
    keyBy:      "ip",
    failPolicy: "insurance",
  },

  /** POST /api/auth/login legacy alias */
  login: {
    points:     Number(process.env.RATE_LIMIT_LOGIN_IP_POINTS) || 10,
    duration:   Number(process.env.RATE_LIMIT_LOGIN_IP_DURATION) || 300,
    keyBy:      "ip",
    failPolicy: "insurance",
  },

  /** POST /api/prompt/optimize */
  promptOptimization: {
    points:     30,   // 30 requests
    duration:   60,   // per 60 seconds
    keyBy:      "user",
    failPolicy: "close",
  },

  /** POST /api/characters/generate-description (configurable, default 10/min) */
  characterDescription: {
    points:     Number(process.env.RATE_LIMIT_CHARACTER_DESC_POINTS) || 10,
    duration:   Number(process.env.RATE_LIMIT_CHARACTER_DESC_DURATION) || 60,
    keyBy:      "user",
    failPolicy: "close",
  },

  /** POST /api/v2/elements/analyze (configurable, default 10/min) */
  elementAnalysis: {
    points:     Number(process.env.RATE_LIMIT_ELEMENT_ANALYZE_POINTS) || 10,
    duration:   Number(process.env.RATE_LIMIT_ELEMENT_ANALYZE_DURATION) || 60,
    keyBy:      "user",
    failPolicy: "close",
  },

  /** Scoped large-body pre-parsing rate limit (IP-based, configurable, default 60/min) */
  scopedLargeBodyIp: {
    points:     Number(process.env.RATE_LIMIT_SCOPED_LARGE_BODY_POINTS) || 60,
    duration:   Number(process.env.RATE_LIMIT_SCOPED_LARGE_BODY_DURATION) || 60,
    keyBy:      "ip",
    failPolicy: "insurance",
  },
};
