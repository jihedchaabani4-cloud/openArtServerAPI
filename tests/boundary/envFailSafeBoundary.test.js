import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isProductionEnvironment,
  assertSecurityConfiguredForEnvironment,
  assertWalletConfiguredForEnvironment,
  assertRateLimitConfiguredForEnvironment,
} from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

describe("RC1.2-S2 — NODE_ENV and Rate Limit Fail-Safe Boundary Tests", () => {
  let origEnv;

  after(async () => {
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
  });

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  describe("1. Inverted NODE_ENV Default (Fail-Safe Production Mode)", () => {
    it("TEST 1: unset NODE_ENV is treated as production mode", () => {
      delete process.env.NODE_ENV;
      assert.equal(isProductionEnvironment(), true);
    });

    it("TEST 2: arbitrary non-development/test NODE_ENV (e.g. 'staging', 'production') is treated as production mode", () => {
      process.env.NODE_ENV = "staging";
      assert.equal(isProductionEnvironment(), true);

      process.env.NODE_ENV = "production";
      assert.equal(isProductionEnvironment(), true);
    });

    it("TEST 3: NODE_ENV='development' is treated as non-production", () => {
      process.env.NODE_ENV = "development";
      assert.equal(isProductionEnvironment(), false);
    });

    it("TEST 4: NODE_ENV='test' is treated as non-production", () => {
      process.env.NODE_ENV = "test";
      assert.equal(isProductionEnvironment(), false);
    });
  });

  describe("2. Security & Wallet Boot Assertions with Inverted Default", () => {
    it("TEST 5: unset NODE_ENV refuses boot if INTERNAL_SECRET is missing or < 32 chars", () => {
      delete process.env.NODE_ENV;
      delete process.env.INTERNAL_SECRET;

      assert.throws(
        () => assertSecurityConfiguredForEnvironment(),
        /INTERNAL_SECRET is required in production mode/
      );

      process.env.INTERNAL_SECRET = "too-short";
      assert.throws(
        () => assertSecurityConfiguredForEnvironment(),
        /at least 32 characters/
      );
    });

    it("TEST 6: unset NODE_ENV refuses boot if WalletService credentials are missing", () => {
      delete process.env.NODE_ENV;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_KEY;

      assert.throws(
        () => assertWalletConfiguredForEnvironment(),
        /WalletService is required in production mode/
      );
    });

    it("TEST 7: NODE_ENV='development' allows boot with missing secrets and wallet credentials", () => {
      process.env.NODE_ENV = "development";
      delete process.env.INTERNAL_SECRET;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_KEY;

      assert.doesNotThrow(() => assertSecurityConfiguredForEnvironment());
      assert.doesNotThrow(() => assertWalletConfiguredForEnvironment());
    });
  });

  describe("3. RATE_LIMIT_STORE Fail-Safe Enforcement", () => {
    it("TEST 8: in production mode, unset RATE_LIMIT_STORE throws at boot", () => {
      process.env.NODE_ENV = "production";
      delete process.env.RATE_LIMIT_STORE;
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.throws(
        () => assertRateLimitConfiguredForEnvironment(),
        /RATE_LIMIT_STORE must be set to 'redis' in production mode/
      );
    });

    it("TEST 9: in production mode, RATE_LIMIT_STORE='memory' without escape hatch throws at boot", () => {
      delete process.env.NODE_ENV; // unset => production
      process.env.RATE_LIMIT_STORE = "memory";
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.throws(
        () => assertRateLimitConfiguredForEnvironment(),
        /RATE_LIMIT_STORE must be set to 'redis' in production mode/
      );
    });

    it("TEST 10: in production mode, RATE_LIMIT_STORE='redis' passes boot cleanly", () => {
      process.env.NODE_ENV = "production";
      process.env.RATE_LIMIT_STORE = "redis";
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.doesNotThrow(() => assertRateLimitConfiguredForEnvironment());
    });

    it("TEST 11: in production mode, RATE_LIMIT_STORE='memory' with ALLOW_IN_MEMORY_RATE_LIMIT='true' logs warning and boots", () => {
      delete process.env.NODE_ENV; // unset => production
      process.env.RATE_LIMIT_STORE = "memory";
      process.env.ALLOW_IN_MEMORY_RATE_LIMIT = "true";

      let warned = false;
      const origWarn = console.warn;
      console.warn = (...args) => {
        warned = true;
      };

      try {
        assert.doesNotThrow(() => assertRateLimitConfiguredForEnvironment());
        assert.equal(warned, true, "Loud warning must be logged when memory rate limit escape is active");
      } finally {
        console.warn = origWarn;
      }
    });

    it("TEST 12: in development mode, memory rate limit store boots without warning or error", () => {
      process.env.NODE_ENV = "development";
      delete process.env.RATE_LIMIT_STORE;
      delete process.env.ALLOW_IN_MEMORY_RATE_LIMIT;

      assert.doesNotThrow(() => assertRateLimitConfiguredForEnvironment());
    });
  });
});
