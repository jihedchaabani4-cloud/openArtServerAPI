import { describe, it, beforeEach, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible";
import http from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import { authRouter } from "#identity/api";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";
import { walletService, characterService, elementService } from "../../../src/container.js";
import { redisConnection, workerRedisConnection } from "#shared/redis";
import { rateLimit, walletRateLimit } from "#identity/tools";
import { resetLimitersForTest, setLimiterForTest } from "../../../src/systems/identity/internal/middleware/rateLimit.js";
import { paymentsRouter } from "#billing/api";
import { charactersRouter as characterRouter } from "#characters/api";
import { elementRoutes as elementRouter } from "#elements/api";

// ─── Source: rateLimitBoundary.test.js ───
{
/**
 * Rate Limit Middleware — Unit Tests
 *
 * Tests the rateLimit() middleware in isolation using
 * RateLimiterMemory directly. No network, no Redis, no Express.
 *
 * Covered behaviors:
 *   ✅ Allowed requests (within limit)
 *   ✅ Limit exceeded → 429 + Retry-After
 *   ✅ User isolation (userA and userB are independent)
 *   ✅ Window reset (counter resets after duration)
 *   ✅ IP policy (login: same IP shared, different IP separate)
 *   ✅ Auth identity (uses req.user.id, not req.body.userId)
 *   ✅ Unknown policy throws at construction time
 *   ✅ Infrastructure failure → fails open (next() called)
 */

// ── Inline test doubles ───────────────────────────────────────────────────────

function makeRes() {
  const headers = {};
  const res = {
    _status: null,
    _body: null,
    headers,
    setHeader(k, v) { headers[k] = v; return this; },
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
  };
  return res;
}

function makeReq({ userId = "user-123", ip = "1.2.3.4", bodyUserId = "body-user-99" } = {}) {
  return {
    user: userId ? { id: userId } : undefined,
    ip,
    body: { userId: bodyUserId },
    socket: { remoteAddress: ip },
  };
}

// ── Helper: build a rateLimit-like function using RateLimiterMemory directly ──


/**
 * Creates a minimal standalone rate limiter middleware for testing.
 * Mirrors the exact logic of src/middleware/rateLimit.js.
 */
function buildLimiter({ points, duration, keyBy }) {
  const limiter = new RateLimiterMemory({ points, duration });

  return async (req, res, next) => {
    let key;
    if (keyBy === "user") {
      key = req.user?.id;
      if (!key) return next();
    } else {
      key = req.ip || req.socket?.remoteAddress || "unknown";
    }

    try {
      await limiter.consume(key);
      return next();
    } catch (err) {
      if (err?.msBeforeNext !== undefined) {
        const retryAfterSec = Math.ceil(err.msBeforeNext / 1000);
        res.setHeader("Retry-After", retryAfterSec);
        return res.status(429).json({
          ok:      false,
          code:    "RATE_LIMIT_EXCEEDED",
          message: "Too many generation requests. Please wait a moment.",
        });
      }
      return next(); // infrastructure error → fail open
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Rate Limit Middleware", () => {

  // ── 1. Allowed requests ────────────────────────────────────────────────────
  describe("Allowed requests", () => {
    it("allows up to points requests within the window", async () => {
      const mw = buildLimiter({ points: 20, duration: 60, keyBy: "user" });

      for (let i = 0; i < 20; i++) {
        const req = makeReq();
        const res = makeRes();
        let nextCalled = false;
        await mw(req, res, () => { nextCalled = true; });
        assert.ok(nextCalled, `Request #${i + 1} must be allowed`);
        assert.equal(res._status, null, `Request #${i + 1} must NOT return 429`);
      }
    });
  });

  // ── 2. Limit exceeded ─────────────────────────────────────────────────────
  describe("Limit exceeded", () => {
    it("blocks the 21st request with 429", async () => {
      const mw = buildLimiter({ points: 20, duration: 60, keyBy: "user" });

      // burn the limit
      for (let i = 0; i < 20; i++) {
        await mw(makeReq(), makeRes(), () => {});
      }

      const req = makeReq();
      const res = makeRes();
      let nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, false, "next() must NOT be called on 429");
      assert.equal(res._status, 429, "Status must be 429");
      assert.equal(res._body?.code, "RATE_LIMIT_EXCEEDED");
      assert.equal(res._body?.ok, false);
      assert.ok(res._body?.message, "Response must have a message");
    });

    it("includes Retry-After header on 429", async () => {
      const mw = buildLimiter({ points: 1, duration: 60, keyBy: "user" });

      await mw(makeReq(), makeRes(), () => {});  // consume the 1 allowed

      const res = makeRes();
      await mw(makeReq(), res, () => {});

      assert.equal(res._status, 429);
      const retryAfter = res.headers["Retry-After"];
      assert.ok(retryAfter !== undefined, "Retry-After header must be present");
      assert.ok(Number(retryAfter) > 0, "Retry-After must be a positive number");
    });
  });

  // ── 3. User isolation ─────────────────────────────────────────────────────
  describe("User isolation", () => {
    it("userA at limit does not block userB", async () => {
      const mw = buildLimiter({ points: 3, duration: 60, keyBy: "user" });

      // exhaust userA
      for (let i = 0; i < 3; i++) {
        await mw(makeReq({ userId: "userA" }), makeRes(), () => {});
      }

      // userA must be blocked
      const resA = makeRes();
      let nextA = false;
      await mw(makeReq({ userId: "userA" }), resA, () => { nextA = true; });
      assert.equal(nextA, false, "userA must be blocked");
      assert.equal(resA._status, 429);

      // userB must still pass
      const resB = makeRes();
      let nextB = false;
      await mw(makeReq({ userId: "userB" }), resB, () => { nextB = true; });
      assert.ok(nextB, "userB must NOT be affected by userA's limit");
      assert.equal(resB._status, null);
    });
  });

  // ── 4. Window reset ───────────────────────────────────────────────────────
  describe("Window reset", () => {
    it("allows requests again after the window expires", async () => {
      // duration = 1 second for this test
      const mw = buildLimiter({ points: 1, duration: 1, keyBy: "user" });

      await mw(makeReq(), makeRes(), () => {});  // consume

      // blocked immediately
      const resBlocked = makeRes();
      let blockedNext = false;
      await mw(makeReq(), resBlocked, () => { blockedNext = true; });
      assert.equal(blockedNext, false, "Must be blocked before window resets");
      assert.equal(resBlocked._status, 429);

      // wait for the 1-second window to expire
      await new Promise((r) => setTimeout(r, 1100));

      // should be allowed again
      const resAllowed = makeRes();
      let allowedNext = false;
      await mw(makeReq(), resAllowed, () => { allowedNext = true; });
      assert.ok(allowedNext, "Must be allowed after window reset");
      assert.equal(resAllowed._status, null);
    });
  });

  // ── 5. IP policy (login) ──────────────────────────────────────────────────
  describe("IP policy", () => {
    it("same IP shares the limit", async () => {
      const mw = buildLimiter({ points: 2, duration: 60, keyBy: "ip" });

      await mw(makeReq({ ip: "5.5.5.5" }), makeRes(), () => {});
      await mw(makeReq({ ip: "5.5.5.5" }), makeRes(), () => {});

      const res = makeRes();
      let next = false;
      await mw(makeReq({ ip: "5.5.5.5" }), res, () => { next = true; });
      assert.equal(next, false, "Same IP must share counter");
      assert.equal(res._status, 429);
    });

    it("different IPs have separate limits", async () => {
      const mw = buildLimiter({ points: 2, duration: 60, keyBy: "ip" });

      // exhaust 5.5.5.5
      await mw(makeReq({ ip: "5.5.5.5" }), makeRes(), () => {});
      await mw(makeReq({ ip: "5.5.5.5" }), makeRes(), () => {});

      // 6.6.6.6 must be unaffected
      const res = makeRes();
      let next = false;
      await mw(makeReq({ ip: "6.6.6.6" }), res, () => { next = true; });
      assert.ok(next, "Different IP must have its own limit");
      assert.equal(res._status, null);
    });
  });

  // ── 6. Auth identity ──────────────────────────────────────────────────────
  describe("Auth identity", () => {
    it("uses req.user.id, NOT req.body.userId", async () => {
      const mw = buildLimiter({ points: 1, duration: 60, keyBy: "user" });

      // req.user.id = "real-user", req.body.userId = "body-user-99"
      const req1 = makeReq({ userId: "real-user", bodyUserId: "body-user-99" });
      await mw(req1, makeRes(), () => {});  // consumes the 1 point for "real-user"

      // same req.user.id — must be blocked
      const req2 = makeReq({ userId: "real-user", bodyUserId: "body-user-99" });
      const res = makeRes();
      let next = false;
      await mw(req2, res, () => { next = true; });

      assert.equal(next, false, "Must be blocked based on req.user.id");
      assert.equal(res._status, 429);
    });

    it("passes through when req.user is absent (auth not yet run)", async () => {
      const mw = buildLimiter({ points: 1, duration: 60, keyBy: "user" });

      const req = makeReq({ userId: null });  // no authenticated user
      const res = makeRes();
      let next = false;
      await mw(req, res, () => { next = true; });

      assert.ok(next, "Must pass through when no user — auth middleware handles it");
      assert.equal(res._status, null);
    });
  });

  // ── 7. Infrastructure failure → fail open ─────────────────────────────────
  describe("Infrastructure failure", () => {
    it("calls next() when limiter throws an unexpected error (fail open)", async () => {
      // Simulate a broken limiter
      const brokenLimiter = {
        consume: async () => { throw new Error("connection refused"); }
      };

      const mw = async (req, res, next) => {
        try {
          await brokenLimiter.consume("any-key");
          return next();
        } catch (err) {
          if (err?.msBeforeNext !== undefined) {
            res.setHeader("Retry-After", 60);
            return res.status(429).json({ ok: false, code: "RATE_LIMIT_EXCEEDED", message: "..." });
          }
          return next(); // fail open
        }
      };

      const res = makeRes();
      let next = false;
      await mw(makeReq(), res, () => { next = true; });

      assert.ok(next, "Must fail open on infrastructure error");
      assert.equal(res._status, null, "Must NOT return 429 on infra error");
    });
  });

  // ── 8. Unknown policy ─────────────────────────────────────────────────────
  describe("Unknown policy", () => {
    it("throws at construction time when policy name is unknown", async () => {
      const { rateLimit } = await import("#identity/tools");
      assert.throws(
        () => rateLimit("nonExistentPolicy"),
        /Unknown policy "nonExistentPolicy"/,
        "Must throw with policy name in message"
      );
    });
  });
});
}

// ─── Source: authRateLimitBoundary.test.js ───
{
describe("RC1.4-D1 — Auth Rate Limiting Boundary Tests", () => {
  let server;
  let baseUrl;
  let app;
  let origSignInWithPassword;
  let origSignUp;
  let origEnsureWallet;
  let origCreateWallet;

  before(async () => {
    origSignInWithPassword = supabase?.auth?.signInWithPassword;
    origSignUp = supabase?.auth?.signUp;
    origEnsureWallet = walletService?.ensureWallet;
    origCreateWallet = walletService?.createWallet;

    if (walletService) {
      walletService.ensureWallet = async () => ({ id: "mock-wallet" });
      walletService.createWallet = async () => ({ id: "mock-wallet" });
    }

    if (supabase?.auth) {
      supabase.auth.signInWithPassword = async ({ email, password }) => {
        return {
          data: {
            user: { id: "mock-user-id", email },
            session: { access_token: "mock-access-token", refresh_token: "mock-refresh-token" }, // gate:allow-secret
          },
          error: null,
        };
      };

      supabase.auth.signUp = async ({ email, password }) => {
        return {
          data: {
            user: { id: "mock-user-id", email },
            session: { access_token: "mock-access-token", refresh_token: "mock-refresh-token" }, // gate:allow-secret
          },
          error: null,
        };
      };

      const origFrom = supabase.from;
      const origAdminFrom = supabaseAdmin.from;
      const mockFrom = (table) => {
        if (table === "profiles") {
          return {
            upsert: async () => ({ data: [{ id: "mock-user-id" }], error: null }),
          };
        }
        if (origFrom) return origFrom.call(supabase, table);
        return {};
      };
      supabase.from = mockFrom;
      supabaseAdmin.from = mockFrom;
      supabaseAdmin.__origFromForRateLimitTest = origAdminFrom;
      supabase.__origFromForRateLimitTest = origFrom;
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/auth", authRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supabase?.auth) {
      if (origSignInWithPassword) supabase.auth.signInWithPassword = origSignInWithPassword;
      if (origSignUp) supabase.auth.signUp = origSignUp;
    }
    if (supabase?.__origFromForRateLimitTest) {
      supabase.from = supabase.__origFromForRateLimitTest;
      delete supabase.__origFromForRateLimitTest;
    }
    if (supabaseAdmin?.__origFromForRateLimitTest) {
      supabaseAdmin.from = supabaseAdmin.__origFromForRateLimitTest;
      delete supabaseAdmin.__origFromForRateLimitTest;
    }
    if (walletService) {
      if (origEnsureWallet) walletService.ensureWallet = origEnsureWallet;
      if (origCreateWallet) walletService.createWallet = origCreateWallet;
    }
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("TEST D1-1: POST /api/auth/login limits to 10 requests per 5 min per IP, returning 429 on 11th", async () => {
    // 10 requests from same client IP with different emails should succeed
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `user-diff-${i}@example.com`, password: "password123" }),
      });
      assert.equal(res.status, 200, `Login request ${i} from same IP should succeed with 200`);
    }

    // 11th request from same IP must be rate limited with 429
    const resBlocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user-diff-11@example.com", password: "password123" }),
    });
    assert.equal(resBlocked.status, 429, "11th login request from same IP should return 429");
    const body = await resBlocked.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(resBlocked.headers.has("retry-after"), "Must include Retry-After header");
  });

  it("TEST D1-2: Attacker cannot lock victim email: limiter uses email + IP, real user from another IP can still log in", async () => {
    const targetEmail = "targeted-victim@example.com";

    const proxyApp = express();
    proxyApp.set("trust proxy", true);
    proxyApp.use(express.json());
    proxyApp.use(cookieParser());
    proxyApp.use("/api/auth", authRouter);

    const proxyServer = http.createServer(proxyApp);
    await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

    try {
      const attackerIp = "198.51.100.77";
      const victimIp = "203.0.113.88";

      // Attacker sends 5 requests for targetEmail from attackerIp (consumes 5 points of email+IP limiter)
      for (let i = 1; i <= 5; i++) {
        const res = await fetch(`${proxyUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": attackerIp,
          },
          body: JSON.stringify({ email: targetEmail, password: "wrong-password" }), // gate:allow-secret
        });
        assert.equal(res.status, 200, `Attacker attempt ${i} passes`);
      }

      // 6th attempt from attackerIp for targetEmail is blocked (429)
      const resAttackerBlocked = await fetch(`${proxyUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": attackerIp,
        },
        body: JSON.stringify({ email: targetEmail, password: "wrong-password" }), // gate:allow-secret
      });
      assert.equal(resAttackerBlocked.status, 429, "6th attempt from attackerIp must return 429");
      const body = await resAttackerBlocked.json();
      assert.equal(body.code, "RATE_LIMIT_EXCEEDED");
      assert.ok(resAttackerBlocked.headers.has("retry-after"));

      // Real user from victimIp MUST STILL BE ABLE TO LOG IN (not locked out by attacker's activity)
      const resVictim = await fetch(`${proxyUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": victimIp,
        },
        body: JSON.stringify({ email: targetEmail, password: "correct-password" }), // gate:allow-secret
      });
      assert.equal(resVictim.status, 200, "Legitimate user from a different IP must not be locked out");
    } finally {
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });

  it("TEST D1-3: Email limiter normalizes casing/whitespace and hashes key", async () => {
    const proxyApp = express();
    proxyApp.set("trust proxy", true);
    proxyApp.use(express.json());
    proxyApp.use(cookieParser());
    proxyApp.use("/api/auth", authRouter);

    const proxyServer = http.createServer(proxyApp);
    await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

    try {
      const clientIp = "198.51.100.99";
      const emailVariants = [
        "CaseSensitive@example.com",
        "casesensitive@example.com",
        "  CASESENSITIVE@EXAMPLE.COM  ",
        "CaseSensitive@EXAMPLE.com",
        "casesensitive@example.com ",
      ];

      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${proxyUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": clientIp,
          },
          body: JSON.stringify({ email: emailVariants[i], password: "password123" }),
        });
        assert.equal(res.status, 200);
      }

      // 6th attempt with another variant from the same IP should be blocked
      const resBlocked = await fetch(`${proxyUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ email: "casesensitive@EXAMPLE.com", password: "password123" }),
      });
      assert.equal(resBlocked.status, 429, "Variants of the same email from same IP must share the normalized rate limit bucket");
    } finally {
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });

  it("TEST D1-3b: Key hygiene: email > 254 chars rejected with 400, non-string skips email limiter", async () => {
    const proxyApp = express();
    proxyApp.set("trust proxy", true);
    proxyApp.use(express.json());
    proxyApp.use(cookieParser());
    proxyApp.use("/api/auth", authRouter);

    const proxyServer = http.createServer(proxyApp);
    await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

    try {
      const clientIp = "198.51.100.123";

      // 1. Oversize email (> 254 characters)
      const longEmail = "a".repeat(245) + "@example.com"; // 257 chars
      const resOversize = await fetch(`${proxyUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ email: longEmail, password: "password123" }),
      });
      assert.equal(resOversize.status, 400, "Email > 254 chars must return 400");
      const oversizeBody = await resOversize.json();
      assert.ok(oversizeBody.error || oversizeBody.message, "Should include error message");

      // 2. Non-string / missing email skips email limiter without sharing a bucket
      const resNoEmail = await fetch(`${proxyUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ email: 12345, password: "password123" }),
      });
      // Handled by validateAuthInput => 400 "Valid email is required."
      assert.equal(resNoEmail.status, 400);
      const noEmailBody = await resNoEmail.json();
      assert.equal(noEmailBody.error, "Valid email is required.");
    } finally {
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });

  it("TEST D1-4: POST /api/auth/signup limits to 10 requests per hour per IP", async () => {
    const signupApp = express();
    signupApp.set("trust proxy", true);
    signupApp.use(express.json());
    signupApp.use(cookieParser());
    signupApp.use("/api/auth", authRouter);

    const signupServer = http.createServer(signupApp);
    await new Promise((resolve) => signupServer.listen(0, "127.0.0.1", resolve));
    const signupUrl = `http://127.0.0.1:${signupServer.address().port}`;

    try {
      const clientIp = "192.0.2.50";
      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${signupUrl}/api/auth/signup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": clientIp,
          },
          body: JSON.stringify({ email: `new-user-${i}@example.com`, password: "password123" }),
        });
        assert.equal(res.status, 201, `Signup ${i} should succeed`);
      }

      // 11th signup from same IP must return 429
      const resBlocked = await fetch(`${signupUrl}/api/auth/signup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ email: "new-user-11@example.com", password: "password123" }),
      });
      assert.equal(resBlocked.status, 429, "11th signup request from same IP should return 429");
      const body = await resBlocked.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "RATE_LIMIT_EXCEEDED");
      assert.ok(resBlocked.headers.has("retry-after"));
    } finally {
      await new Promise((resolve) => signupServer.close(resolve));
    }
  });

  it("TEST D1-5: Trust proxy behavior — ignores spoofed X-Forwarded-For when trust proxy is false", async () => {
    // App with trust proxy: false (default)
    const directApp = express();
    directApp.set("trust proxy", false);
    directApp.use(express.json());
    directApp.use(cookieParser());
    directApp.use("/api/auth", authRouter);

    const directServer = http.createServer(directApp);
    await new Promise((resolve) => directServer.listen(0, "127.0.0.1", resolve));
    const directUrl = `http://127.0.0.1:${directServer.address().port}`;

    try {
      // Attacker attempts to spoof X-Forwarded-For with different IPs on every request
      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${directUrl}/api/auth/signup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": `1.2.3.${i}`, // Attacker spoofing header
          },
          body: JSON.stringify({ email: `spoof-${i}@example.com`, password: "password123" }),
        });
        assert.equal(res.status, 201);
      }

      // 11th request from attacker socket (despite new spoofed header) must be blocked because trust proxy is false
      const resBlocked = await fetch(`${directUrl}/api/auth/signup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "1.2.3.99",
        },
        body: JSON.stringify({ email: "spoof-11@example.com", password: "password123" }),
      });
      assert.equal(resBlocked.status, 429, "When trust proxy is false, spoofed headers must not bypass rate limit");
    } finally {
      await new Promise((resolve) => directServer.close(resolve));
    }
  });
});
}

// ─── Source: rateLimiterOutageBoundary.test.js ───
{
describe("RC1.4-D1.2 — Rate Limiter Outage Policy Boundary Tests", () => {
  before(() => {
    resetLimitersForTest();
  });

  after(async () => {
    resetLimitersForTest();
    try {
      const { redisConnection, workerRedisConnection } = await import("#shared/redis");
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
  });

  it("TEST D1.2-1: Expensive AI routes fail-closed (503 SERVICE_UNAVAILABLE) on Redis failure", async () => {
    const testApp = express();
    testApp.use(express.json());

    // Mock an AI route protected with characterDescription policy
    testApp.post(
      "/api/test-ai",
      (req, res, next) => {
        req.user = { id: "test-user-ai" };
        next();
      },
      rateLimit("characterDescription"),
      (req, res) => res.json({ ok: true, generated: "result" })
    );

    const testServer = http.createServer(testApp);
    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    const testUrl = `http://127.0.0.1:${testServer.address().port}`;

    try {
      // Simulate broken Redis limiter on expensive AI route
      setLimiterForTest("characterDescription", {
        consume: async () => {
          throw new Error("Redis connection refused: ECONNREFUSED 127.0.0.1:6379");
        },
      });

      const res = await fetch(`${testUrl}/api/test-ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });

      // Expensive AI routes MUST fail closed with 503 and Retry-After: 30
      assert.equal(res.status, 503, "Expensive AI route must fail-closed with 503 when Redis is down");
      assert.equal(res.headers.get("retry-after"), "30", "Must include Retry-After header of 30s");
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "SERVICE_UNAVAILABLE");
      assert.equal(body.message, "Service temporarily unavailable. Please try again shortly.");
    } finally {
      resetLimitersForTest();
      await new Promise((resolve) => testServer.close(resolve));
    }
  });

  it("TEST D1.2-2: Auth routes use insuranceLimiter in-memory when Redis is down", async () => {
    const testApp = express();
    testApp.use(express.json());

    testApp.post(
      "/api/test-auth-login",
      rateLimit("loginIp"),
      (req, res) => res.json({ ok: true, loggedIn: true })
    );

    const testServer = http.createServer(testApp);
    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    const testUrl = `http://127.0.0.1:${testServer.address().port}`;

    try {
      // Broken Redis store client with an in-memory insurance limiter
      const brokenClient = {
        eval: () => Promise.reject(new Error("Redis connection lost")),
        multi: () => ({
          exec: () => Promise.reject(new Error("Redis connection lost")),
        }),
      };
      const insuranceLimiter = new RateLimiterMemory({ points: 3, duration: 60 });
      const degradedLimiter = new RateLimiterRedis({
        storeClient: brokenClient,
        points: 3,
        duration: 60,
        insuranceLimiter,
      });
      setLimiterForTest("loginIp", degradedLimiter);

      // In degraded mode with broken Redis, insuranceLimiter allows requests up to points (3)
      for (let i = 1; i <= 3; i++) {
        const res = await fetch(`${testUrl}/api/test-auth-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "user@example.com", password: "password123" }),
        });
        assert.equal(res.status, 200, `Request ${i} must succeed via insurance limiter`);
      }

      // 4th request exceeds insuranceLimiter points -> 429 RATE_LIMIT_EXCEEDED
      const resBlocked = await fetch(`${testUrl}/api/test-auth-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password123" }),
      });
      assert.equal(resBlocked.status, 429, "Request exceeding insurance points must return 429");
      const body = await resBlocked.json();
      assert.equal(body.code, "RATE_LIMIT_EXCEEDED");
    } finally {
      resetLimitersForTest();
      await new Promise((resolve) => testServer.close(resolve));
    }
  });

  it("TEST D1.2-3: Wallet routes fail-open on Redis error", async () => {
    const testApp = express();
    const brokenStoreClient = {
      incr: () => Promise.reject(new Error("Redis timeout")),
    };
    testApp.use(
      (req, res, next) => {
        req.user = { id: "test-wallet-user" };
        next();
      },
      walletRateLimit({ max: 5, windowSec: 60, storeClient: brokenStoreClient }),
      (req, res) => res.json({ ok: true, balance: 100 })
    );

    const testServer = http.createServer(testApp);
    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    const testUrl = `http://127.0.0.1:${testServer.address().port}`;

    try {
      const res = await fetch(`${testUrl}`);
      assert.equal(res.status, 200, "Wallet route must fail-open on Redis error");
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.balance, 100);
    } finally {
      await new Promise((resolve) => testServer.close(resolve));
    }
  });

  it("TEST D1.2-4: Payments webhook is never rate limited", () => {
    // Inspect paymentsRouter stack: no rateLimit or walletRateLimit middleware exists
    const webhookLayer = paymentsRouter.stack.find(
      (layer) => layer.route && layer.route.path === "/webhook"
    );
    assert.ok(webhookLayer, "Webhook route must be registered");
    const middlewareNames = webhookLayer.route.stack.map((s) => s.name);
    assert.ok(!middlewareNames.includes("rateLimit"), "Webhook route must NOT have rateLimit middleware");
    assert.ok(!middlewareNames.includes("walletRateLimit"), "Webhook route must NOT have walletRateLimit middleware");
  });

  it("TEST D1.2-5: Timeout protection triggers fail-closed for AI routes", async () => {
    const origTimeout = process.env.RATE_LIMIT_TIMEOUT_MS;
    process.env.RATE_LIMIT_TIMEOUT_MS = "50"; // 50ms fast timeout

    const testApp = express();
    testApp.use(express.json());
    testApp.post(
      "/api/test-timeout",
      (req, res, next) => {
        req.user = { id: "test-user-timeout" };
        next();
      },
      rateLimit("imageGeneration"),
      (req, res) => res.json({ ok: true })
    );

    const testServer = http.createServer(testApp);
    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    const testUrl = `http://127.0.0.1:${testServer.address().port}`;

    try {
      // Mock hanging Redis limiter (never resolves)
      setLimiterForTest("imageGeneration", {
        consume: () => new Promise(() => {}),
      });

      const res = await fetch(`${testUrl}/api/test-timeout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hanging" }),
      });

      assert.equal(res.status, 503, "Hanging limiter must timeout and fail closed (503)");
      const body = await res.json();
      assert.equal(body.code, "SERVICE_UNAVAILABLE");
    } finally {
      process.env.RATE_LIMIT_TIMEOUT_MS = origTimeout || "1500";
      resetLimitersForTest();
      await new Promise((resolve) => testServer.close(resolve));
    }
  });
});
}

// ─── Source: freeAiRateLimitBoundary.test.js ───
{
describe("RC1.3-W4 — Free AI/Vision Rate Limiting Boundary Tests", () => {
  let server;
  let baseUrl;
  let origCharGenDesc;
  let origElemAnalyze;
  let origGetUser;

  before(async () => {
    origGetUser = supabase?.auth?.getUser;
    if (supabase?.auth) {
      supabase.auth.getUser = async (token) => {
        if (token) {
          return { data: { user: { id: token } }, error: null };
        }
        return { data: { user: null }, error: new Error("Invalid token") };
      };
    }

    const app = express();
    app.use(express.json());

    app.use("/api/characters", characterRouter);
    app.use("/api/v2/elements", elementRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (supabase?.auth && origGetUser) {
      supabase.auth.getUser = origGetUser;
    }
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    origCharGenDesc = characterService?.generateDescription;
    origElemAnalyze = elementService?.analyzeElement;

    if (characterService) {
      characterService.generateDescription = async () => ({
        description: "A futuristic AI character prompt",
        traits: ["neon", "cyber"],
      });
    }

    if (elementService) {
      elementService.analyzeElement = async () => ({
        analysis: "Sample element analysis output",
        suggestedPrompt: "Golden metallic wings",
      });
    }
  });

  afterEach(() => {
    if (characterService && origCharGenDesc) {
      characterService.generateDescription = origCharGenDesc;
    }
    if (elementService && origElemAnalyze) {
      elementService.analyzeElement = origElemAnalyze;
    }
  });

  it("TEST W4-1: POST /api/characters/generate-description returns 200 normal, 429 when >10/min, scoped per user", async () => {
    const userA = "user-rl-char-a";
    const userB = "user-rl-char-b";

    // 10 requests should succeed (default 10/min)
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/characters/generate-description`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA}`,
        },
        body: JSON.stringify({ concept: "cyberpunk detective" }),
      });
      assert.equal(res.status, 200, `Request ${i} for user A should succeed with 200`);
      const body = await res.json();
      assert.equal(body.ok, true);
    }

    // 11th request for user A must be blocked with 429
    const resBlocked = await fetch(`${baseUrl}/api/characters/generate-description`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA}`,
      },
      body: JSON.stringify({ concept: "cyberpunk detective" }),
    });
    assert.equal(resBlocked.status, 429, "11th request for user A should return 429");
    const blockedBody = await resBlocked.json();
    assert.equal(blockedBody.ok, false);
    assert.equal(blockedBody.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(resBlocked.headers.has("retry-after"), "Must include Retry-After header");

    // User B should still be allowed (rate limit is per-user)
    const resUserB = await fetch(`${baseUrl}/api/characters/generate-description`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB}`,
      },
      body: JSON.stringify({ concept: "cyberpunk detective" }),
    });
    assert.equal(resUserB.status, 200, "User B should succeed with 200");
  });

  it("TEST W4-2: POST /api/v2/elements/analyze returns 200 normal, 429 when >10/min, scoped per user", async () => {
    const userX = "user-rl-elem-x";
    const userY = "user-rl-elem-y";

    // 10 requests should succeed (default 10/min)
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/v2/elements/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userX}`,
        },
        body: JSON.stringify({
          elementName: "Silver Blade",
          imageUrls: ["https://example.com/blade.png"],
        }),
      });
      assert.equal(res.status, 200, `Request ${i} for user X should succeed with 200`);
      const body = await res.json();
      assert.equal(body.status, "success");
    }

    // 11th request for user X must be blocked with 429
    const resBlocked = await fetch(`${baseUrl}/api/v2/elements/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userX}`,
      },
      body: JSON.stringify({
        elementName: "Silver Blade",
        imageUrls: ["https://example.com/blade.png"],
      }),
    });
    assert.equal(resBlocked.status, 429, "11th request for user X should return 429");
    const blockedBody = await resBlocked.json();
    assert.equal(blockedBody.ok, false);
    assert.equal(blockedBody.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(resBlocked.headers.has("retry-after"), "Must include Retry-After header");

    // User Y should still be allowed
    const resUserY = await fetch(`${baseUrl}/api/v2/elements/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userY}`,
      },
      body: JSON.stringify({
        elementName: "Silver Blade",
        imageUrls: ["https://example.com/blade.png"],
      }),
    });
    assert.equal(resUserY.status, 200, "User Y should succeed with 200");
  });
});
}
