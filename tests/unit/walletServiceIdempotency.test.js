import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createWalletService } from "../../src/platform/billing/billingFactory.js";
import { WalletError } from "../../src/platform/billing/BillingErrors.js";

/**
 * Stateful repository test double emulating the exact PostgreSQL RPC behaviors
 * from supabase/migrations/20261018161500_baseline.sql:
 * - commit_transaction (baseline.sql:84)
 * - rollback_transaction (baseline.sql:237)
 */
class RpcEmulatingTransactionRepository {
    constructor() {
        this.transactions = new Map();
        this.shouldThrowOnFind = false;
    }

    async resolveTransactionRpc(fnName, referenceId) {
        const tx = this.transactions.get(referenceId);
        if (!tx) {
            return {
                tx: null,
                error: { message: `Transaction ${referenceId} not found` },
            };
        }
        if (tx.status !== "PENDING") {
            // Emulates Postgres RPC commit_transaction (baseline.sql:84) and rollback_transaction (baseline.sql:237):
            // RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
            return {
                tx: null,
                error: { message: `Transaction is not PENDING (current status: ${tx.status})` },
            };
        }
        const nextStatus = fnName === "commit_transaction" ? "COMPLETED" : "FAILED";
        tx.status = nextStatus;
        tx.updated_at = new Date().toISOString();
        return { tx: { ...tx }, error: null };
    }

    async findByReference(referenceId) {
        if (this.shouldThrowOnFind) {
            throw new WalletError("Simulated DB connection failure in findByReference", "DB_ERROR");
        }
        const tx = this.transactions.get(referenceId);
        return tx ? { ...tx } : null;
    }

    async mergeMetadata(referenceId, extraMetadata) {
        const tx = this.transactions.get(referenceId);
        if (tx) {
            tx.metadata = { ...(tx.metadata || {}), ...extraMetadata };
        }
    }
}

describe("Billing Business System — WalletService Idempotency & Conflict Contract", () => {
    let repo;
    let service;

    beforeEach(() => {
        repo = new RpcEmulatingTransactionRepository();
        // Uses createWalletService verifying the injected transactionRepo parameter
        service = createWalletService({ transactionRepo: repo });
    });

    describe("commitHoldIdempotent()", () => {
        it("first call commits PENDING hold; second call recovers idempotently after RPC throws", async () => {
            repo.transactions.set("ref-c1", { id: "tx-1", status: "PENDING", reference_id: "ref-c1" });

            // 1st call: transitions PENDING -> COMPLETED
            const first = await service.commitHoldIdempotent("ref-c1");
            assert.equal(first.status, "COMPLETED");
            assert.equal(first.reference_id, "ref-c1");

            // 2nd call: RPC throws 'Transaction is not PENDING (current status: COMPLETED)'
            // WalletService catches the error, inspects repo state via findByReference, and recovers
            const second = await service.commitHoldIdempotent("ref-c1");
            assert.equal(second.status, "COMPLETED");
            assert.equal(second.reference_id, "ref-c1");
        });

        it("rethrows error when hold was previously FAILED (conflicting terminal state)", async () => {
            repo.transactions.set("ref-c2", { id: "tx-2", status: "FAILED", reference_id: "ref-c2" });

            await assert.rejects(
                async () => {
                    await service.commitHoldIdempotent("ref-c2");
                },
                (err) => {
                    assert.match(err.message, /Transaction is not PENDING \(current status: FAILED\)/);
                    return true;
                }
            );
        });

        it("rethrows error when hold record does not exist in repository", async () => {
            await assert.rejects(
                async () => {
                    await service.commitHoldIdempotent("ref-nonexistent");
                },
                (err) => {
                    assert.match(err.message, /Transaction ref-nonexistent not found/);
                    return true;
                }
            );
        });
        it("rethrows original RPC error when findByReference fails with DB error during commit idempotency check", async () => {
            repo.transactions.set("ref-c3", { id: "tx-5", status: "COMPLETED", reference_id: "ref-c3" });
            repo.shouldThrowOnFind = true;

            await assert.rejects(
                async () => {
                    await service.commitHoldIdempotent("ref-c3");
                },
                (err) => {
                    assert.match(err.message, /Transaction is not PENDING \(current status: COMPLETED\)/);
                    return true;
                }
            );
        });
    });

    describe("rollbackHoldIdempotent()", () => {
        it("first call rolls back PENDING hold; second call recovers idempotently after RPC throws", async () => {
            repo.transactions.set("ref-r1", { id: "tx-3", status: "PENDING", reference_id: "ref-r1" });

            // 1st call: transitions PENDING -> FAILED
            const first = await service.rollbackHoldIdempotent("ref-r1", { reason: "User cancelled" });
            assert.equal(first.status, "FAILED");
            assert.equal(first.reference_id, "ref-r1");

            // 2nd call: RPC throws 'Transaction is not PENDING (current status: FAILED)'
            // WalletService catches the error, inspects repo state via findByReference, and recovers
            const second = await service.rollbackHoldIdempotent("ref-r1", { reason: "Worker retry" });
            assert.equal(second.status, "FAILED");
            assert.equal(second.reference_id, "ref-r1");
        });

        it("rethrows error when hold was previously COMPLETED (financial state conflict)", async () => {
            repo.transactions.set("ref-r2", { id: "tx-4", status: "COMPLETED", reference_id: "ref-r2" });

            await assert.rejects(
                async () => {
                    await service.rollbackHoldIdempotent("ref-r2", { reason: "Late error" });
                },
                (err) => {
                    assert.match(err.message, /Transaction is not PENDING \(current status: COMPLETED\)/);
                    return true;
                }
            );
        });

        it("rethrows original RPC error when findByReference fails with DB error during rollback idempotency check", async () => {
            repo.transactions.set("ref-r3", { id: "tx-6", status: "FAILED", reference_id: "ref-r3" });
            repo.shouldThrowOnFind = true;

            await assert.rejects(
                async () => {
                    await service.rollbackHoldIdempotent("ref-r3");
                },
                (err) => {
                    assert.match(err.message, /Transaction is not PENDING \(current status: FAILED\)/);
                    return true;
                }
            );
        });
    });
});
