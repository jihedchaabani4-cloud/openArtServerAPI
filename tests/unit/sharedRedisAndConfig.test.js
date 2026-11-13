import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  envConfig,
  loggingConfig,
  redisConnection,
  workerRedisConnection,
  rateLimitRedisConnection,
  waitForRateLimitRedis,
  RECONCILIATION_CACHE_KEY,
  createLogger,
  AppError,
} from "#shared";

describe("Shared Redis & Config Kernel", () => {
  it("resolves through #shared alias successfully", () => {
    assert.ok(envConfig);
    assert.ok(loggingConfig);
    assert.equal(typeof createLogger, "function");
    assert.equal(typeof AppError, "function");
  });

  it("provides clean environment config flags", () => {
    assert.equal(typeof envConfig.isProduction, "boolean");
    assert.equal(typeof envConfig.isTest, "boolean");
    assert.equal(typeof envConfig.isDevelopment, "boolean");
    assert.equal(typeof envConfig.level, "string");
  });

  it("exports Redis connection singletons and constants", async () => {
    assert.ok(redisConnection);
    assert.ok(workerRedisConnection);
    assert.ok(rateLimitRedisConnection);
    assert.equal(RECONCILIATION_CACHE_KEY, "reconciliation:latest");

    const ready = await waitForRateLimitRedis(100);
    assert.equal(ready, true); // in test environment, resolves immediately to true
  });
});
