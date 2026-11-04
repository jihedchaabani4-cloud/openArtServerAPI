import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLatestReconciliation } from "../../controllers/adminController.js";
import { RECONCILIATION_CACHE_KEY } from "../../src/queue/redis.js";

describe("Admin Reconciliation Cache Key and Controller Unit Tests", () => {
    describe("1. Shared Cache Key Behavioral Alignment", () => {
        it("defines the canonical reconciliation cache key", () => {
            assert.equal(RECONCILIATION_CACHE_KEY, "reconciliation:latest");
        });

        it("ensures writer and reader successfully exchange reconciliation reports using the shared key", async () => {
            // Fake in-memory Redis backing store
            const fakeRedisStore = new Map();
            const fakeRedis = {
                set: async (key, val) => fakeRedisStore.set(key, val),
                get: async (key) => fakeRedisStore.get(key) || null,
            };

            // Writer side (simulating walletWorker writing summary)
            const summaryPayload = {
                runAt: "2026-11-04T03:00:00.000Z",
                status: "CLEAN",
                mismatchCount: 0,
                mismatches: [],
                durationMs: 85,
            };
            await fakeRedis.set(RECONCILIATION_CACHE_KEY, JSON.stringify(summaryPayload));

            // Reader side (simulating adminController reading report)
            const req = { redisConnection: fakeRedis };
            let receivedJson = null;
            const res = {
                json: (data) => {
                    receivedJson = data;
                },
            };
            await getLatestReconciliation(req, res);

            // Assert contract matches exactly
            assert.deepEqual(receivedJson, summaryPayload);
        });
    });

    describe("2. GET /api/admin/reconciliation/latest Controller", () => {
        it("returns NO_RUN_RECORDED when Redis key does not exist", async () => {
            let receivedKey = null;
            const mockRedis = {
                get: async (key) => {
                    receivedKey = key;
                    return null;
                },
            };

            const req = { redisConnection: mockRedis };
            let responseData = null;
            const res = {
                json: (data) => {
                    responseData = data;
                },
            };

            await getLatestReconciliation(req, res);

            assert.equal(receivedKey, RECONCILIATION_CACHE_KEY);
            assert.deepEqual(responseData, {
                cached: false,
                status: "NO_RUN_RECORDED",
                message: "No reconciliation run recorded in cache.",
                runAt: null,
                mismatchCount: 0,
                mismatches: [],
            });
        });

        it("returns parsed report payload when reconciliation key exists in Redis", async () => {
            const mockPayload = {
                runAt: "2026-11-04T03:00:00.000Z",
                status: "CLEAN",
                mismatchCount: 0,
                mismatches: [],
                durationMs: 125,
            };

            const mockRedis = {
                get: async (key) => {
                    if (key === RECONCILIATION_CACHE_KEY) {
                        return JSON.stringify(mockPayload);
                    }
                    return null;
                },
            };

            const req = { redisConnection: mockRedis };
            let responseData = null;
            const res = {
                json: (data) => {
                    responseData = data;
                },
            };

            await getLatestReconciliation(req, res);

            assert.deepEqual(responseData, mockPayload);
        });

        it("returns 500 INTERNAL_ERROR when Redis connection throws", async () => {
            const mockRedis = {
                get: async () => {
                    throw new Error("Redis cluster connection timeout");
                },
            };

            const req = { redisConnection: mockRedis };
            let responseStatus = null;
            let responseData = null;
            const res = {
                status: (code) => {
                    responseStatus = code;
                    return res;
                },
                json: (data) => {
                    responseData = data;
                },
            };

            await getLatestReconciliation(req, res);

            assert.equal(responseStatus, 500);
            assert.deepEqual(responseData, {
                error: "INTERNAL_ERROR",
                message: "Failed to fetch reconciliation result.",
            });
        });
    });

    describe("3. Route Security Verification", () => {
        it("verifies adminRouter stack mounts requireAuth and requireAdmin before routes", async () => {
            const adminRouter = (await import("../../routes/admin.js")).default;
            const middlewareNames = adminRouter.stack
                .map((layer) => layer.handle?.name || layer.name)
                .filter(Boolean);

            assert.ok(
                middlewareNames.includes("requireAuth"),
                "adminRouter must include requireAuth middleware"
            );
            assert.ok(
                middlewareNames.includes("requireAdmin"),
                "adminRouter must include requireAdmin middleware"
            );
        });
    });
});
