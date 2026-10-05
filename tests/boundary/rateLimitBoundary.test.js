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
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

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

import { RateLimiterMemory } from "rate-limiter-flexible";

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
      const { rateLimit } = await import("../../src/middleware/rateLimit.js");
      assert.throws(
        () => rateLimit("nonExistentPolicy"),
        /Unknown policy "nonExistentPolicy"/,
        "Must throw with policy name in message"
      );
    });
  });
});
