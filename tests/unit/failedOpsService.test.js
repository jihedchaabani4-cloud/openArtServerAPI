import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
    FailedOpsService,
    FAILED_OPS_BACKOFF_BASE_MS,
    FAILED_OPS_BACKOFF_MULTIPLIER,
    FAILED_OPS_DEFAULT_MAX_RETRIES,
} from "#billing/tools";
import { handleRetryFailedOps, replayOperation } from "#billing/tools";
import { redisConnection, workerRedisConnection } from "#shared";

/**
 * Stateful in-memory repository double for FailedOpsRepository.
 * Emulates the persistence layer without mocking return values.
 */
class InMemoryFailedOpsRepository {
    constructor() {
        this.records = new Map();
        this.nextId = 1;
    }

    async findExisting(referenceId, operationType) {
        for (const rec of this.records.values()) {
            if (rec.reference_id === referenceId && rec.operation_type === operationType) {
                return { ...rec };
            }
        }
        return null;
    }

    async insertFailedOp(op) {
        const id = `op-${this.nextId++}`;
        const record = {
            id,
            retry_count: 0,
            max_retries: FAILED_OPS_DEFAULT_MAX_RETRIES,
            ...op,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        this.records.set(id, record);
        return { data: record, error: null };
    }

    async getPendingOps() {
        const now = Date.now();
        const pending = [];
        for (const rec of this.records.values()) {
            if (rec.status === "PENDING") {
                if (!rec.next_retry_at || new Date(rec.next_retry_at).getTime() <= now) {
                    pending.push({ ...rec });
                }
            }
        }
        return pending;
    }

    async markCompleted(id) {
        const rec = this.records.get(id);
        if (rec) {
            rec.status = "COMPLETED";
            rec.updated_at = new Date().toISOString();
        }
    }

    async markRetryScheduled(id, retryCount, nextRetryAt) {
        const rec = this.records.get(id);
        if (rec) {
            rec.retry_count = retryCount;
            rec.next_retry_at = nextRetryAt;
            rec.updated_at = new Date().toISOString();
        }
    }

    async markAbandoned(id, reason) {
        const rec = this.records.get(id);
        if (rec) {
            rec.status = "ABANDONED";
            rec.failure_reason = reason;
            rec.updated_at = new Date().toISOString();
        }
    }
}

describe("Billing Business System — FailedOpsService & Worker Lifecycle", () => {
    let repo;
    let service;

    after(async () => {
        await redisConnection?.quit().catch(() => redisConnection?.disconnect());
        await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    });

    beforeEach(() => {
        repo = new InMemoryFailedOpsRepository();
        service = new FailedOpsService({ failedOpsRepo: repo });
    });

    describe("record()", () => {
        it("records a new failed operation with PENDING status", async () => {
            await service.record({
                operationType: "COMMIT",
                referenceId: "ref-101",
                userId: "user-1",
                amount: 15,
                failureReason: "Database timeout during commit",
            });

            assert.equal(repo.records.size, 1);
            const op = Array.from(repo.records.values())[0];
            assert.equal(op.operation_type, "COMMIT");
            assert.equal(op.reference_id, "ref-101");
            assert.equal(op.user_id, "user-1");
            assert.equal(op.amount, 15);
            assert.equal(op.status, "PENDING");
            assert.equal(op.retry_count, 0);
            assert.equal(op.failure_reason, "Database timeout during commit");
        });

        it("idempotently ignores recording duplicate (operationType, referenceId)", async () => {
            await service.record({
                operationType: "ROLLBACK",
                referenceId: "ref-dup-1",
                userId: "user-2",
                amount: 20,
            });
            assert.equal(repo.records.size, 1);

            // Replay same record call
            await service.record({
                operationType: "ROLLBACK",
                referenceId: "ref-dup-1",
                userId: "user-2",
                amount: 20,
            });
            assert.equal(repo.records.size, 1, "Duplicate failed op must not create second row");
        });

        it("handles repository errors gracefully without throwing (documents swallow-by-design behavior / G11)", async () => {
            const failingRepo = {
                async findExisting() {
                    throw new Error("Disk full");
                },
            };
            const failingService = new FailedOpsService({ failedOpsRepo: failingRepo });

            await assert.doesNotReject(async () => {
                await failingService.record({
                    operationType: "COMMIT",
                    referenceId: "ref-err",
                    userId: "user-3",
                });
            });
        });
    });

    describe("markRetryScheduled() & Backoff Calculation", () => {
        // Source of truth for backoff base and exponent: FailedOpsService.js:127
        // (const delayMs = FAILED_OPS_BACKOFF_BASE_MS * Math.pow(FAILED_OPS_BACKOFF_MULTIPLIER, retryCount))
        it("calculates exponential backoff delay based on retry_count using production constants", async () => {
            await service.record({
                operationType: "COMMIT",
                referenceId: "ref-backoff",
                userId: "user-4",
            });
            const op = (await service.getPendingOps())[0];

            const beforeTime = Date.now();
            await service.markRetryScheduled(op.id, 1);
            const updated1 = repo.records.get(op.id);
            assert.equal(updated1.retry_count, 1);

            // Retry 1: FAILED_OPS_BACKOFF_BASE_MS * FAILED_OPS_BACKOFF_MULTIPLIER^1 = 120,000 ms (+2 minutes)
            const scheduled1 = new Date(updated1.next_retry_at).getTime();
            const expectedDelay1 = FAILED_OPS_BACKOFF_BASE_MS * Math.pow(FAILED_OPS_BACKOFF_MULTIPLIER, 1);
            const delta1 = scheduled1 - beforeTime;
            assert.ok(Math.abs(delta1 - expectedDelay1) <= 5000, `Expected ~${expectedDelay1}ms delay, got ${delta1}ms`);

            // Retry 2: FAILED_OPS_BACKOFF_BASE_MS * FAILED_OPS_BACKOFF_MULTIPLIER^2 = 240,000 ms (+4 minutes)
            await service.markRetryScheduled(op.id, 2);
            const updated2 = repo.records.get(op.id);
            assert.equal(updated2.retry_count, 2);
            const scheduled2 = new Date(updated2.next_retry_at).getTime();
            const expectedDelay2 = FAILED_OPS_BACKOFF_BASE_MS * Math.pow(FAILED_OPS_BACKOFF_MULTIPLIER, 2);
            const delta2 = scheduled2 - beforeTime;
            assert.ok(Math.abs(delta2 - expectedDelay2) <= 5000, `Expected ~${expectedDelay2}ms delay, got ${delta2}ms`);

            // Retry 3: FAILED_OPS_BACKOFF_BASE_MS * FAILED_OPS_BACKOFF_MULTIPLIER^3 = 480,000 ms (+8 minutes)
            await service.markRetryScheduled(op.id, 3);
            const updated3 = repo.records.get(op.id);
            const scheduled3 = new Date(updated3.next_retry_at).getTime();
            const expectedDelay3 = FAILED_OPS_BACKOFF_BASE_MS * Math.pow(FAILED_OPS_BACKOFF_MULTIPLIER, 3);
            const delta3 = scheduled3 - beforeTime;
            assert.ok(Math.abs(delta3 - expectedDelay3) <= 5000, `Expected ~${expectedDelay3}ms delay, got ${delta3}ms`);
        });
    });

    describe("markAbandoned()", () => {
        it("transitions status to ABANDONED with failure reason", async () => {
            await service.record({
                operationType: "COMMIT",
                referenceId: "ref-abandon",
                userId: "user-5",
            });
            const op = (await service.getPendingOps())[0];

            await service.markAbandoned(op.id, "Max retries reached (5/5)");
            const abandoned = repo.records.get(op.id);
            assert.equal(abandoned.status, "ABANDONED");
            assert.equal(abandoned.failure_reason, "Max retries reached (5/5)");
        });
    });

    describe("handleRetryFailedOps() Worker Reconciliation", () => {
        it("replays pending op successfully and marks COMPLETED", async () => {
            await service.record({
                operationType: "COMMIT",
                referenceId: "ref-worker-success",
                userId: "user-6",
            });
            const op = (await service.getPendingOps())[0];

            let completedId = null;
            let scheduledCalled = false;
            let abandonedCalled = false;
            let replayedOp = null;

            // Injected controllable replay dependency: explicitly decides success
            const controllableReplay = async (operation) => {
                replayedOp = operation;
            };

            const fakeOps = {
                async getPendingOps() {
                    return [op];
                },
                async markCompleted(id) {
                    completedId = id;
                },
                async markRetryScheduled() {
                    scheduledCalled = true;
                },
                async markAbandoned() {
                    abandonedCalled = true;
                },
            };

            const count = await handleRetryFailedOps({
                failedOpsService: fakeOps,
                replayFn: controllableReplay,
            });

            assert.equal(count, 1, "Should report 1 operation successfully replayed");
            assert.equal(replayedOp?.id, op.id);
            assert.equal(completedId, op.id, "Must mark operation COMPLETED on successful replay");
            assert.equal(scheduledCalled, false, "Must NOT schedule retry on success");
            assert.equal(abandonedCalled, false, "Must NOT abandon on success");
        });

        it("schedules next retry on failure when retry_count < max_retries", async () => {
            await service.record({
                operationType: "COMMIT",
                referenceId: "ref-fail-backoff",
                userId: "user-7",
            });
            const op = (await service.getPendingOps())[0];
            op.retry_count = 1;
            op.max_retries = 5;

            let scheduledCount = null;
            let scheduledId = null;
            let completedCalled = false;
            let abandonedCalled = false;

            // Injected controllable replay dependency: explicitly throws transient failure
            const failingReplay = async () => {
                throw new Error("Controllable simulated failure (e.g. transient network timeout)");
            };

            const fakeOps = {
                async getPendingOps() {
                    return [op];
                },
                async markCompleted() {
                    completedCalled = true;
                },
                async markRetryScheduled(id, newRetry) {
                    scheduledId = id;
                    scheduledCount = newRetry;
                },
                async markAbandoned() {
                    abandonedCalled = true;
                },
            };

            await handleRetryFailedOps({
                failedOpsService: fakeOps,
                replayFn: failingReplay,
            });

            assert.equal(scheduledId, op.id);
            assert.equal(scheduledCount, 2, "retry_count must increment from 1 to 2");
            assert.equal(completedCalled, false, "Must NOT mark completed on error");
            assert.equal(abandonedCalled, false, "Must NOT abandon while retry_count < max_retries");
        });

        it("abandons operation when newRetryCount reaches max_retries", async () => {
            await service.record({
                operationType: "COMMIT",
                referenceId: "ref-fail-terminal",
                userId: "user-8",
            });
            const op = (await service.getPendingOps())[0];
            op.retry_count = 4;
            op.max_retries = 5; // next retry is 5 >= max_retries

            let abandonedId = null;
            let abandonedReason = null;
            let completedCalled = false;
            let scheduledCalled = false;

            // Injected controllable replay dependency: explicitly throws terminal failure
            const failingReplay = async () => {
                throw new Error("Controllable simulated terminal failure");
            };

            const fakeOps = {
                async getPendingOps() {
                    return [op];
                },
                async markCompleted() {
                    completedCalled = true;
                },
                async markRetryScheduled() {
                    scheduledCalled = true;
                },
                async markAbandoned(id, reason) {
                    abandonedId = id;
                    abandonedReason = reason;
                },
            };

            await handleRetryFailedOps({
                failedOpsService: fakeOps,
                replayFn: failingReplay,
            });

            assert.equal(abandonedId, op.id);
            assert.equal(abandonedReason, "Controllable simulated terminal failure");
            assert.equal(completedCalled, false, "Must NOT mark completed on terminal failure");
            assert.equal(scheduledCalled, false, "Must NOT schedule retry on terminal failure");
        });

        it("proves DEFAULT behavior: when replayFn is omitted, handleRetryFailedOps delegates to replayOperation with injected walletService", async () => {
            const op = {
                id: "op-default",
                operation_type: "COMMIT",
                reference_id: "ref-default-replay",
                retry_count: 0,
                max_retries: 5,
            };

            let committedRef = null;
            let markCompletedCalled = false;

            const fakeWallet = {
                async commitHoldIdempotent(ref) {
                    committedRef = ref;
                },
            };

            const fakeOps = {
                async getPendingOps() {
                    return [op];
                },
                async markCompleted(id) {
                    markCompletedCalled = (id === op.id);
                },
                async markRetryScheduled() {},
                async markAbandoned() {},
            };

            // Call without replayFn - tests default delegation to replayOperation(op, { walletService })
            const count = await handleRetryFailedOps({
                failedOpsService: fakeOps,
                walletService: fakeWallet,
            });

            assert.equal(count, 1);
            assert.equal(committedRef, "ref-default-replay");
            assert.equal(markCompletedCalled, true);
        });
    });

    describe("replayOperation() Contract with injected walletService double", () => {
        it("executes COMMIT on walletService", async () => {
            let calledRef = null;
            const walletDouble = {
                async commitHoldIdempotent(ref) {
                    calledRef = ref;
                },
            };
            await replayOperation(
                { operation_type: "COMMIT", reference_id: "ref-c" },
                { walletService: walletDouble }
            );
            assert.equal(calledRef, "ref-c");
        });

        it("executes ROLLBACK on walletService", async () => {
            let calledRef = null;
            const walletDouble = {
                async rollback(ref) {
                    calledRef = ref;
                },
            };
            await replayOperation(
                { operation_type: "ROLLBACK", reference_id: "ref-r" },
                { walletService: walletDouble }
            );
            assert.equal(calledRef, "ref-r");
        });

        it("executes CREDIT on walletService", async () => {
            let creditPayload = null;
            const walletDouble = {
                async credit(params) {
                    creditPayload = params;
                },
            };
            await replayOperation(
                {
                    operation_type: "CREDIT",
                    reference_id: "ref-cr",
                    user_id: "u-1",
                    amount: 50,
                    payload: { metadata: { source: "test" } },
                },
                { walletService: walletDouble }
            );
            assert.equal(creditPayload.userId, "u-1");
            assert.equal(creditPayload.amount, 50);
            assert.equal(creditPayload.referenceId, "ref-cr");
            assert.equal(creditPayload.metadata?.source, "test");
        });

        it("executes DEBIT on walletService", async () => {
            let debitPayload = null;
            const walletDouble = {
                async hold(params) {
                    debitPayload = params;
                },
            };
            await replayOperation(
                {
                    operation_type: "DEBIT",
                    reference_id: "ref-deb",
                    user_id: "u-2",
                    amount: 30,
                    payload: { metadata: { source: "test_debit" } },
                },
                { walletService: walletDouble }
            );
            assert.equal(debitPayload.userId, "u-2");
            assert.equal(debitPayload.amount, 30);
            assert.equal(debitPayload.referenceId, "ref-deb");
            assert.equal(debitPayload.metadata?.source, "test_debit");
        });

        it("propagates walletService errors on failed replay", async () => {
            const failingWallet = {
                async commitHoldIdempotent() {
                    throw new Error("Simulated RPC execution failure");
                },
            };
            await assert.rejects(
                async () => {
                    await replayOperation(
                        { operation_type: "COMMIT", reference_id: "ref-err" },
                        { walletService: failingWallet }
                    );
                },
                /Simulated RPC execution failure/
            );
        });

        it("throws on unknown operation type", async () => {
            await assert.rejects(
                async () => {
                    await replayOperation(
                        { operation_type: "UNKNOWN_ACTION", reference_id: "ref-unknown" },
                        { walletService: {} }
                    );
                },
                /Unknown operation_type: UNKNOWN_ACTION/
            );
        });
    });
});
