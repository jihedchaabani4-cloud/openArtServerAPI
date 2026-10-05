import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import authRouter from "../../routes/authRoutes.js";
import { supabase } from "../../lib/supabase.js";
import { walletService } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

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
            session: { access_token: "mock-access-token", refresh_token: "mock-refresh-token" },
          },
          error: null,
        };
      };

      supabase.auth.signUp = async ({ email, password }) => {
        return {
          data: {
            user: { id: "mock-user-id", email },
            session: { access_token: "mock-access-token", refresh_token: "mock-refresh-token" },
          },
          error: null,
        };
      };

      const origFrom = supabase.from;
      supabase.from = (table) => {
        if (table === "profiles") {
          return {
            upsert: async () => ({ data: [{ id: "mock-user-id" }], error: null }),
          };
        }
        if (origFrom) return origFrom.call(supabase, table);
        return {};
      };
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
          body: JSON.stringify({ email: targetEmail, password: "wrong-password" }),
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
        body: JSON.stringify({ email: targetEmail, password: "wrong-password" }),
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
        body: JSON.stringify({ email: targetEmail, password: "correct-password" }),
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
