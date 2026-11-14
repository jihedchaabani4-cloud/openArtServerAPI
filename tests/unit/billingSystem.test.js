process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "#shared";
import {
    getCreditBalance,
    reserveCredits,
    settleCredits,
    rollbackCredits,
    addCredits,
    listTransactions,
    listCreditPackages,
    getCreditPackage,
    resolvePackageCredits,
    configureBilling,
    getBillingService,
    getWalletService,
    getCreditPackageRepository,
    getFailedOpsService,
    getWalletRepository,
    createWalletService,
    createFailedOpsService,
    createBillingRepositories,
    WalletService,
    FailedOpsService,
    reconcileExpiredHolds,
    handleExpireStaleHolds,
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
} from "#billing/tools";
import billingApiRouter from "#billing/api";

function makeFakeWalletService({ initialBalance = 150 } = {}) {
    const balances = new Map();
    const transactions = [];
    const reservations = new Map();

    return {
        balances,
        transactions,
        reservations,
        async getBalance(userId) {
            if (!balances.has(userId)) {
                balances.set(userId, initialBalance);
            }
            return balances.get(userId);
        },
        async reserve({ userId, amount, referenceId, metadata = {} }) {
            const current = await this.getBalance(userId);
            if (amount === 0) {
                const res = {
                    kind: "NO_CHARGE",
                    status: "ACTIVE",
                    referenceId,
                    amount: 0,
                    metadata,
                };
                reservations.set(referenceId, res);
                return res;
            }
            if (current < amount) {
                const err = new Error(`Insufficient funds: needed ${amount}, had ${current}`);
                err.code = "INSUFFICIENT_FUNDS";
                err.available = current;
                throw err;
            }
            balances.set(userId, current - amount);
            const res = {
                kind: "CHARGEABLE",
                status: "HELD",
                referenceId,
                amount,
                metadata,
                transaction: {
                    id: `tx_${referenceId}`,
                    wallet_id: `wallet_${userId}`,
                    amount,
                    type: "DEBIT",
                    status: "PENDING",
                },
            };
            reservations.set(referenceId, res);
            transactions.push(res.transaction);
            return res;
        },
        async settle(reservationOrRef, extraMetadata = null) {
            const refId = typeof reservationOrRef === "string" ? reservationOrRef : reservationOrRef?.referenceId;
            const res = reservations.get(refId);
            if (res) {
                res.status = res.kind === "NO_CHARGE" ? "COMPLETED" : "COMMITTED";
                if (res.transaction) {
                    res.transaction.status = "COMPLETED";
                }
                return { ...res };
            }
            return { status: "committed", referenceId: refId };
        },
        async release(reservationOrRef, extraMetadata = null) {
            const refId = typeof reservationOrRef === "string" ? reservationOrRef : reservationOrRef?.referenceId;
            const res = reservations.get(refId);
            if (res && res.kind === "CHARGEABLE" && res.status === "HELD") {
                res.status = "RELEASED";
                const userId = res.metadata?.userId || "user_test";
                const curr = balances.get(userId) ?? 0;
                balances.set(userId, curr + res.amount);
                if (res.transaction) {
                    res.transaction.status = "FAILED";
                }
            }
            return { status: "released", referenceId: refId };
        },
        async credit({ userId, amount, referenceId, metadata = {} }) {
            const curr = await this.getBalance(userId);
            const updated = curr + amount;
            balances.set(userId, updated);
            const tx = {
                id: `credit_${referenceId}`,
                userId,
                amount,
                balance: updated,
            };
            transactions.push(tx);
            return tx;
        },
        async getTransactions(userId, limit = 20) {
            return {
                transactions: transactions.slice(0, limit),
                nextCursor: null,
            };
        },
        async reapExpiredHolds() {
            const expired = [];
            for (const [refId, res] of reservations.entries()) {
                if (res.status === "HELD") {
                    res.status = "RELEASED";
                    expired.push({
                        holdId: refId,
                        referenceId: refId,
                        amount: res.amount,
                        workflowId: res.metadata?.workflowId || null,
                        mediaId: res.metadata?.mediaId || null,
                    });
                }
            }
            return expired;
        },
    };
}

describe("System 3: Billing & Wallet Contract & Gateway Tests", () => {
    let fakeWalletService;

    beforeEach(() => {
        fakeWalletService = makeFakeWalletService({ initialBalance: 100 });
        configureBilling({ walletService: fakeWalletService });
    });

    it("public tools gateway exports all required DTO operations and classes", () => {
        assert.equal(typeof getCreditBalance, "function");
        assert.equal(typeof reserveCredits, "function");
        assert.equal(typeof settleCredits, "function");
        assert.equal(typeof rollbackCredits, "function");
        assert.equal(typeof addCredits, "function");
        assert.equal(typeof listTransactions, "function");
        assert.equal(typeof listCreditPackages, "function");
        assert.equal(typeof getCreditPackage, "function");
        assert.equal(typeof resolvePackageCredits, "function");
        assert.equal(typeof createWalletService, "function");
        assert.equal(typeof createBillingRepositories, "function");
        assert.equal(typeof createFailedOpsService, "function");
        assert.equal(typeof WalletService, "function");
        assert.equal(typeof FailedOpsService, "function");
    });

    it("public api gateway exports Express router", () => {
        assert.ok(billingApiRouter);
        assert.equal(typeof billingApiRouter, "function");
        assert.equal(typeof billingApiRouter.use, "function");
    });

    it("typed error hierarchy conforms to AppError and carries HTTP status codes", () => {
        const valErr = new BillingValidationError("Invalid payload");
        assert.ok(valErr instanceof BillingError);
        assert.ok(valErr instanceof AppError);
        assert.equal(valErr.statusCode, 400);
        assert.equal(valErr.code, "BILLING_VALIDATION_ERROR");

        const notFoundErr = new BillingNotFoundError("Wallet missing");
        assert.equal(notFoundErr.statusCode, 404);
        assert.equal(notFoundErr.code, "NOT_FOUND");

        const fundsErr = new BillingInsufficientFundsError(50, 10);
        assert.equal(fundsErr.statusCode, 402);
        assert.equal(fundsErr.code, "INSUFFICIENT_FUNDS");
        assert.equal(fundsErr.required, 50);
        assert.equal(fundsErr.available, 10);

        const conflictErr = new BillingConflictError("State conflict");
        assert.equal(conflictErr.statusCode, 409);

        const configErr = new BillingConfigurationError("Missing RPC");
        assert.equal(configErr.statusCode, 500);

        const legacyWalletErr = new WalletError("Duplicate", "DUPLICATE_TRANSACTION");
        assert.ok(legacyWalletErr instanceof BillingError);
        assert.equal(legacyWalletErr.statusCode, 409);
    });

    it("getCreditBalance resolves balance for valid user and rejects missing userId", async () => {
        const result = await getCreditBalance({ userId: "u_test_1" });
        assert.deepEqual(result, { userId: "u_test_1", balance: 100 });

        await assert.rejects(
            async () => getCreditBalance({ userId: "" }),
            (err) => err instanceof BillingValidationError && err.statusCode === 400
        );
    });

    it("reserveCredits handles NO_CHARGE (0 credits) without financial debit", async () => {
        const res = await reserveCredits({
            userId: "u_test_1",
            amount: 0,
            referenceId: "ref_free_1",
            metadata: { operation: "free_preview" },
        });

        assert.equal(res.kind, "NO_CHARGE");
        assert.equal(res.status, "ACTIVE");
        assert.equal(res.amount, 0);

        // Balance remains untouched
        const bal = await getCreditBalance({ userId: "u_test_1" });
        assert.equal(bal.balance, 100);

        // Settle NO_CHARGE
        const settled = await settleCredits(res);
        assert.equal(settled.status, "COMPLETED");
    });

    it("reserveCredits handles CHARGEABLE hold, debit, and settlement", async () => {
        const res = await reserveCredits({
            userId: "u_test_1",
            amount: 30,
            referenceId: "ref_paid_1",
            metadata: { workflowId: "wf_1" },
        });

        assert.equal(res.kind, "CHARGEABLE");
        assert.equal(res.status, "HELD");
        assert.equal(res.amount, 30);

        // Balance decremented
        const bal = await getCreditBalance({ userId: "u_test_1" });
        assert.equal(bal.balance, 70);

        // Settle
        const settled = await settleCredits(res);
        assert.equal(settled.status, "COMMITTED");
    });

    it("reserveCredits throws BillingInsufficientFundsError when balance is deficient", async () => {
        await assert.rejects(
            async () => {
                await reserveCredits({
                    userId: "u_test_1",
                    amount: 500,
                    referenceId: "ref_fail_1",
                });
            },
            (err) => {
                assert.ok(err instanceof BillingInsufficientFundsError);
                assert.equal(err.statusCode, 402);
                assert.equal(err.code, "INSUFFICIENT_FUNDS");
                return true;
            }
        );
    });

    it("rollbackCredits restores balance for CHARGEABLE hold", async () => {
        const res = await reserveCredits({
            userId: "u_test_2",
            amount: 40,
            referenceId: "ref_rollback_1",
            metadata: { userId: "u_test_2" },
        });

        const balBefore = await getCreditBalance({ userId: "u_test_2" });
        assert.equal(balBefore.balance, 60);

        await rollbackCredits(res);

        const balAfter = await getCreditBalance({ userId: "u_test_2" });
        assert.equal(balAfter.balance, 100);
    });

    it("addCredits deposits funds into user wallet", async () => {
        const res = await addCredits({
            userId: "u_test_3",
            amount: 50,
            referenceId: "topup_1",
        });

        assert.equal(res.amount, 50);
        assert.equal(res.balance, 150);

        const bal = await getCreditBalance({ userId: "u_test_3" });
        assert.equal(bal.balance, 150);
    });

    it("listTransactions retrieves paginated transactions", async () => {
        await addCredits({ userId: "u_test_4", amount: 25, referenceId: "topup_4" });
        const res = await listTransactions({ userId: "u_test_4", limit: 10 });
        assert.ok(Array.isArray(res.transactions));
        assert.ok(res.transactions.length >= 1);
    });

    it("listCreditPackages and resolvePackageCredits use configured repo or fetcher", async () => {
        const mockRepo = {
            async listActivePackages() {
                return [{ id: "pkg_1", name: "Starter", credits: 100, price_usd: 10 }];
            },
            async findActiveById(id) {
                return id === "pkg_1" ? { id: "pkg_1", credits: 100 } : null;
            },
            async findCreditsByVariantId(vid) {
                return vid === "variant_123" ? 250 : null;
            },
            async findCreditsById(id) {
                return id === "pkg_1" ? 100 : null;
            },
        };

        configureBilling({ walletService: fakeWalletService, creditPackageRepo: mockRepo });

        const pkgs = await listCreditPackages();
        assert.equal(pkgs.length, 1);
        assert.equal(pkgs[0].name, "Starter");

        const singlePkg = await getCreditPackage("pkg_1");
        assert.equal(singlePkg.credits, 100);

        const variantCredits = await resolvePackageCredits({ variantId: "variant_123" });
        assert.equal(variantCredits, 250);
    });

    it("reconcileExpiredHolds sweeps expired holds cleanly with error isolation", async () => {
        await reserveCredits({
            userId: "u_test_5",
            amount: 20,
            referenceId: "ref_expire_1",
            metadata: { workflowId: "wf_stale", mediaId: "media_stale" },
        });

        let failCalled = false;
        const mockLifecycle = {
            async failForExpiredHold({ holdId, workflowId, mediaId }) {
                failCalled = true;
                assert.equal(holdId, "ref_expire_1");
                assert.equal(workflowId, "wf_stale");
                assert.equal(mediaId, "media_stale");
            },
        };

        const reaped = await reconcileExpiredHolds({
            walletService: fakeWalletService,
            lifecycleService: mockLifecycle,
        });

        assert.equal(reaped.length, 1);
        assert.equal(failCalled, true);
    });
});
