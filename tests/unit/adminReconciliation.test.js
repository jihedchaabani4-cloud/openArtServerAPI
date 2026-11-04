import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getLatestReconciliation } from "../../controllers/adminController.js";
import { RECONCILIATION_CACHE_KEY } from "../../src/queue/redis.js";

describe("Admin Reconciliation Cache Key and Controller Unit Tests", () => {
    describe("1. Shared Cache Key Alignment", () => {
        it("defines the canonical reconciliation cache key", () => {
            assert.equal(RECONCILIATION_CACHE_KEY, "reconciliation:latest");
        });

        it("verifies walletWorker.js writes to RECONCILIATION_CACHE_KEY", () => {
            const workerPath = path.resolve(process.cwd(), "src/workers/walletWorker.js");
            const workerCode = fs.readFileSync(workerPath, "utf8");
            assert.ok(
                workerCode.includes("redisConnection.set(RECONCILIATION_CACHE_KEY"),
                "walletWorker.js must use RECONCILIATION_CACHE_KEY for persisting reconciliation results"
            );
            assert.ok(
                !workerCode.includes('"reconcile:latest"'),
                "walletWorker.js must no longer use the stale 'reconcile:latest' key"
            );
        });

        it("verifies adminController.js reads from RECONCILIATION_CACHE_KEY", () => {
            const controllerPath = path.resolve(process.cwd(), "controllers/adminController.js");
            const controllerCode = fs.readFileSync(controllerPath, "utf8");
            assert.ok(
                controllerCode.includes("redis.get(RECONCILIATION_CACHE_KEY)"),
                "adminController.js must use RECONCILIATION_CACHE_KEY for reading reconciliation results"
            );
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
        it("verifies routes/admin.js enforces requireAuth and requireAdmin router-wide", () => {
            const adminRoutePath = path.resolve(process.cwd(), "routes/admin.js");
            const routeCode = fs.readFileSync(adminRoutePath, "utf8");

            assert.ok(
                routeCode.includes("router.use(requireAuth, requireAdmin)"),
                "routes/admin.js must enforce requireAuth and requireAdmin middleware router-wide"
            );
            assert.ok(
                routeCode.includes('router.get("/reconciliation/latest", getLatestReconciliation)'),
                "routes/admin.js must register /reconciliation/latest handler"
            );

            const authIdx = routeCode.indexOf("router.use(requireAuth, requireAdmin)");
            const reconIdx = routeCode.indexOf('router.get("/reconciliation/latest"');
            assert.ok(
                authIdx < reconIdx,
                "requireAuth and requireAdmin must be mounted before the /reconciliation/latest route"
            );
        });
    });
});
