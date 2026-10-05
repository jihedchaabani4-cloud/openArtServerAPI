import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible";
import { rateLimit, resetLimitersForTest, setLimiterForTest } from "../../src/middleware/rateLimit.js";
import { walletRateLimit } from "../../src/middleware/walletRateLimit.js";
import paymentsRouter from "../../routes/payments.js";

describe("RC1.4-D1.2 — Rate Limiter Outage Policy Boundary Tests", () => {
  before(() => {
    resetLimitersForTest();
  });

  after(async () => {
    resetLimitersForTest();
    try {
      const { redisConnection, workerRedisConnection } = await import("../../src/queue/redis.js");
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
