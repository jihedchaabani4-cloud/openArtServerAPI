import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { redisConnection } from "../../src/queue/redis.js";
import { getUseCaseQueue } from "../../src/services/jobQueueService.js";
import { useCaseWorker } from "../../src/workers/useCaseWorker.js";
import { walletMaintenanceQueue } from "../../src/queue/walletQueue.js";

// Prevent ioredis reconnect backoff loop in unit test environment
if (redisConnection?.options) {
    redisConnection.options.retryStrategy = () => null;
}

describe("Queue and Worker Error Event Handlers", () => {
    after(() => {
        // Disconnect immediately without waiting for graceful quit or ping timers
        if (typeof redisConnection?.disconnect === "function") {
            redisConnection.disconnect(false);
        }
    });

    it("useCaseQueue handles error events without throwing or crashing", async () => {
        const queue = await getUseCaseQueue();
        assert.doesNotThrow(() => {
            queue.emit("error", new Error("Simulated Redis disconnect on useCaseQueue"));
        });
    });

    it("useCaseWorker handles error events without throwing or crashing", () => {
        assert.doesNotThrow(() => {
            useCaseWorker.emit("error", new Error("Simulated Redis disconnect on useCaseWorker"));
        });
    });

    it("walletMaintenanceQueue handles error events without throwing or crashing", () => {
        assert.doesNotThrow(() => {
            walletMaintenanceQueue.emit("error", new Error("Simulated Redis disconnect on walletMaintenanceQueue"));
        });
    });
});
