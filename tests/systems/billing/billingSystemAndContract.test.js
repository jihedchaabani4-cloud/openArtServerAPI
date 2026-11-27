import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "#shared";
import * as billingToolsNamespace from "#billing/tools";
import * as billingApiNamespace from "#billing/api";
import {
    getCreditBalance,
    reserveCredits,
    settleCredits,
    rollbackCredits,
    addCredits,
    listTransactions,
    listCreditPackages,
    configureBilling,
    createWalletService,
    createFailedOpsService,
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
} from "#billing/tools";
import { paymentsRouter, walletRouter } from "#billing/api";
import { WalletService } from "../../../src/systems/billing/internal/services/WalletService.js";
import { reconcileExpiredHolds } from "../../../src/systems/billing/internal/services/ReservationReaperService.js";
import { getCreditPackage, resolvePackageCredits } from "../../../src/systems/billing/internal/services/serviceAccessor.js";
import { ExecutionEngine } from "#generation/tools";
import { GraphCompiler, createDefaultV3NodeRegistry, getV3Workflow } from "../../../src/systems/generation/internal/v3/index.js";

// ─── Source: billingSystem.test.js ───
{
process.env.NODE_ENV = "test";


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

    it("seals #billing/tools and #billing/api to exact production surface (zero repo/internal/router leaks)", () => {
        const expectedToolsExports = [
            "BillingConfigurationError",
            "BillingConflictError",
            "BillingError",
            "BillingInsufficientFundsError",
            "BillingNotFoundError",
            "BillingValidationError",
            "WalletError",
            "addCredits",
            "configureBilling",
            "createFailedOpsService",
            "createWalletService",
            "extendHold",
            "getCreditBalance",
            "listCreditPackages",
            "listTransactions",
            "reserveCredits",
            "rollbackCredits",
            "runReservationReaper",
            "settleCredits",
            "startWalletWorker",
            "stopWalletWorker",
        ].sort();
        assert.deepEqual(Object.keys(billingToolsNamespace).sort(), expectedToolsExports);
        assert.deepEqual(Object.keys(billingApiNamespace).sort(), ["paymentsRouter", "walletRouter"]);

        for (const forbidden of [
            "WalletRepository",
            "TransactionRepository",
            "CreditPackageRepository",
            "FailedOpsRepository",
            "UsageEventRepository",
            "createBillingRepositories",
            "getWalletRepository",
            "getTransactionRepository",
            "getUsageEventRepository",
            "getCreditPackageRepository",
            "WalletService",
            "FailedOpsService",
            "getWalletService",
            "getBillingService",
            "getFailedOpsService",
            "getCreditPackage",
            "resolvePackageCredits",
            "reconcileExpiredHolds",
            "handleExpireStaleHolds",
            "walletMaintenanceQueue",
            "walletWorker",
            "handleRetryFailedOps",
            "replayOperation",
            "default",
        ]) {
            assert.equal(billingToolsNamespace[forbidden], undefined, `#billing/tools must not export ${forbidden}`);
        }

        for (const forbidden of ["default", "handleWebhook", "PUBLIC_PACKAGE_FIELDS", "toPublicPackage", "adminRouter"]) {
            assert.equal(billingApiNamespace[forbidden], undefined, `#billing/api must not export ${forbidden}`);
        }
    });

    it("public api gateway exports Express paymentsRouter and walletRouter", () => {
        assert.equal(typeof paymentsRouter, "function");
        assert.equal(typeof paymentsRouter.use, "function");
        assert.equal(typeof walletRouter, "function");
        assert.equal(typeof walletRouter.use, "function");
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
}

// ─── Source: billingContract.test.js ───
{
process.env.NODE_ENV = "test";


function makeFakeWalletService({ initialBalance = 100 } = {}) {
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
            const current = await this.getBalance(userId);
            balances.set(userId, current + amount);
            const tx = {
                id: `tx_${referenceId}`,
                userId,
                amount,
                type: "CREDIT",
                status: "COMPLETED",
                balance: current + amount,
                metadata,
            };
            transactions.push(tx);
            return tx;
        },
        async getTransactions(userId, limit = 20, before = null, beforeId = null) {
            const userTxs = transactions.filter((t) => t.userId === userId || t.wallet_id === `wallet_${userId}`);
            return {
                transactions: userTxs.slice(0, limit),
                hasMore: false,
                nextCursor: null,
            };
        },
    };
}

describe("Billing Business System — Public Contract & Capabilities (Phase 2.1)", () => {
    describe("Public Barrel Surface & Error Hierarchy (Rule 3, Rule 8)", () => {
        it("exports all 7 canonical capability functions", () => {
            assert.equal(typeof getCreditBalance, "function");
            assert.equal(typeof reserveCredits, "function");
            assert.equal(typeof settleCredits, "function");
            assert.equal(typeof rollbackCredits, "function");
            assert.equal(typeof addCredits, "function");
            assert.equal(typeof listTransactions, "function");
            assert.equal(typeof listCreditPackages, "function");
        });

        it("exports the complete typed Billing error hierarchy extending AppError", () => {
            const baseErr = new BillingError("TEST_CODE", "test message", { statusCode: 500 });
            assert.ok(baseErr instanceof AppError);
            assert.ok(baseErr instanceof BillingError);
            assert.equal(baseErr.statusCode, 500);

            const valErr = new BillingValidationError("Invalid parameters");
            assert.ok(valErr instanceof BillingError);
            assert.ok(valErr instanceof AppError);
            assert.equal(valErr.statusCode, 400);
            assert.equal(valErr.code, "BILLING_VALIDATION_ERROR");

            const notFoundErr = new BillingNotFoundError("Wallet not found");
            assert.ok(notFoundErr instanceof BillingError);
            assert.equal(notFoundErr.statusCode, 404);
            assert.equal(notFoundErr.code, "NOT_FOUND");

            const fundsErr = new BillingInsufficientFundsError(50, 20);
            assert.ok(fundsErr instanceof BillingError);
            assert.equal(fundsErr.statusCode, 402);
            assert.equal(fundsErr.code, "INSUFFICIENT_FUNDS");
            assert.equal(fundsErr.required, 50);
            assert.equal(fundsErr.available, 20);

            const conflictErr = new BillingConflictError("Hold expired");
            assert.ok(conflictErr instanceof BillingError);
            assert.equal(conflictErr.statusCode, 409);
            assert.equal(conflictErr.code, "CONFLICT");

            const configErr = new BillingConfigurationError("Unconfigured");
            assert.ok(configErr instanceof BillingError);
            assert.equal(configErr.statusCode, 500);
            assert.equal(configErr.code, "BILLING_CONFIG_ERROR");

            const legacyWalletErr = new WalletError("Missing", "WALLET_NOT_FOUND");
            assert.ok(legacyWalletErr instanceof BillingError);
            assert.ok(legacyWalletErr instanceof AppError);
            assert.equal(legacyWalletErr.statusCode, 404);
            assert.equal(legacyWalletErr.code, "WALLET_NOT_FOUND");
        });
    });

    describe("Input Validation & Boundary Enforcement (Rule 4, Rule 11)", () => {
        it("rejects getCreditBalance when userId is missing", async () => {
            await assert.rejects(
                () => getCreditBalance({}, {}),
                (err) => err instanceof BillingValidationError && /userId is required/.test(err.message)
            );
        });

        it("rejects reserveCredits with invalid or negative amounts", async () => {
            const fakeWallet = makeFakeWalletService();
            await assert.rejects(
                () => reserveCredits({ userId: "user-1", amount: -5, referenceId: "ref-1" }, { walletService: fakeWallet }),
                (err) => err instanceof BillingValidationError && /Invalid billing amount/.test(err.message)
            );
            await assert.rejects(
                () => reserveCredits({ userId: "user-1", amount: NaN, referenceId: "ref-1" }, { walletService: fakeWallet }),
                (err) => err instanceof BillingValidationError && /Invalid billing amount/.test(err.message)
            );
        });

        it("rejects reserveCredits when referenceId is missing", async () => {
            const fakeWallet = makeFakeWalletService();
            await assert.rejects(
                () => reserveCredits({ userId: "user-1", amount: 10 }, { walletService: fakeWallet }),
                (err) => err instanceof BillingValidationError && /referenceId is required/.test(err.message)
            );
        });

        it("rejects addCredits with zero or negative amounts", async () => {
            const fakeWallet = makeFakeWalletService();
            await assert.rejects(
                () => addCredits({ userId: "user-1", amount: 0, referenceId: "ref-1" }, { walletService: fakeWallet }),
                (err) => err instanceof BillingValidationError && /positive number/.test(err.message)
            );
        });

        it("rejects settleCredits when target reference is missing", async () => {
            const fakeWallet = makeFakeWalletService();
            await assert.rejects(
                () => settleCredits(null, { walletService: fakeWallet }),
                (err) => err instanceof BillingValidationError && /required to settle/.test(err.message)
            );
        });

        it("rejects rollbackCredits when target reference is missing", async () => {
            const fakeWallet = makeFakeWalletService();
            await assert.rejects(
                () => rollbackCredits(null, { walletService: fakeWallet }),
                (err) => err instanceof BillingValidationError && /required to rollback/.test(err.message)
            );
        });

        it("throws BillingConfigurationError when no walletService is configured", async () => {
            configureBilling({ walletService: null });
            await assert.rejects(
                () => getCreditBalance({ userId: "user-1" }, {}),
                (err) => err instanceof BillingConfigurationError
            );
        });
    });

    describe("Financial Lifecycle Operations via Capabilities", () => {
        it("reads credit balance for an existing user", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 150 });
            configureBilling({ walletService: fakeWallet });

            const result = await getCreditBalance({ userId: "user-10" });
            assert.deepEqual(result, { userId: "user-10", balance: 150 });
        });

        it("handles zero-cost reservation as NO_CHARGE without balance movement", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 100 });
            configureBilling({ walletService: fakeWallet });

            const res = await reserveCredits({
                userId: "user-20",
                amount: 0,
                referenceId: "ref-free-1",
            });

            assert.equal(res.kind, "NO_CHARGE");
            assert.equal(res.status, "ACTIVE");
            assert.equal(res.amount, 0);

            const balance = await getCreditBalance({ userId: "user-20" });
            assert.equal(balance.balance, 100);
        });

        it("handles chargeable reservation and decrements balance", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 100 });
            configureBilling({ walletService: fakeWallet });

            const res = await reserveCredits({
                userId: "user-30",
                amount: 30,
                referenceId: "ref-paid-1",
            });

            assert.equal(res.kind, "CHARGEABLE");
            assert.equal(res.status, "HELD");
            assert.equal(res.amount, 30);

            const balance = await getCreditBalance({ userId: "user-30" });
            assert.equal(balance.balance, 70);
        });

        it("throws BillingInsufficientFundsError (402) when balance is insufficient", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 25 });
            configureBilling({ walletService: fakeWallet });

            await assert.rejects(
                () => reserveCredits({ userId: "user-40", amount: 50, referenceId: "ref-expensive-1" }),
                (err) => {
                    assert.ok(err instanceof BillingInsufficientFundsError);
                    assert.equal(err.statusCode, 402);
                    assert.equal(err.required, 50);
                    assert.equal(err.available, 25);
                    return true;
                }
            );
        });

        it("settles an active hold successfully", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 100 });
            configureBilling({ walletService: fakeWallet });

            const res = await reserveCredits({
                userId: "user-50",
                amount: 40,
                referenceId: "ref-settle-1",
            });

            const settlement = await settleCredits(res);
            assert.equal(settlement.status, "committed");
            assert.equal(settlement.referenceId, "ref-settle-1");
        });

        it("rolls back an active hold and restores user balance", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 100 });
            configureBilling({ walletService: fakeWallet });

            const res = await reserveCredits({
                userId: "user-60",
                amount: 45,
                referenceId: "ref-rollback-1",
                metadata: { userId: "user-60" },
            });

            const beforeRollback = await getCreditBalance({ userId: "user-60" });
            assert.equal(beforeRollback.balance, 55);

            const rollbackResult = await rollbackCredits(res);
            assert.equal(rollbackResult.status, "released");

            const afterRollback = await getCreditBalance({ userId: "user-60" });
            assert.equal(afterRollback.balance, 100);
        });

        it("adds credits to user wallet via addCredits capability", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 50 });
            configureBilling({ walletService: fakeWallet });

            const result = await addCredits({
                userId: "user-70",
                amount: 200,
                referenceId: "ls_order_12345",
            });

            assert.equal(result.amount, 200);
            assert.equal(result.balance, 250);

            const balance = await getCreditBalance({ userId: "user-70" });
            assert.equal(balance.balance, 250);
        });

        it("lists user transactions", async () => {
            const fakeWallet = makeFakeWalletService({ initialBalance: 50 });
            configureBilling({ walletService: fakeWallet });

            await addCredits({ userId: "user-80", amount: 100, referenceId: "order-1" });
            const list = await listTransactions({ userId: "user-80" });

            assert.ok(Array.isArray(list.transactions));
            assert.equal(list.transactions.length, 1);
            assert.equal(list.transactions[0].amount, 100);
        });

        it("lists credit packages via injected fetcher or default fallback", async () => {
            const mockPackages = [
                { id: "pack_100", credits: 100, price: 10 },
                { id: "pack_500", credits: 500, price: 40 },
            ];
            const packages = await listCreditPackages({}, { packageFetcher: async () => mockPackages });
            assert.deepEqual(packages, mockPackages);
        });
    });
});
}

// ─── Source: compactBillingMetadataBoundary.test.js ───
{
describe("D2.3 — GraphCompiler & ExecutionEngine Black-Box Launch Contract Tests", () => {
  it("TEST 1: GraphCompiler.compile returns a minimal DAG plan (activeNodeIds, activeNodes, waves) without duplicating large inputs", () => {
    const compiler = new GraphCompiler(createDefaultV3NodeRegistry());
    const plan = compiler.compile(getV3Workflow("video-generation-v3"));
    assert.strictEqual(plan.workflowId, "video-generation-v3");
    assert.ok(Array.isArray(plan.activeNodeIds) && plan.activeNodeIds.length === 4);
    assert.ok(Array.isArray(plan.waves) && plan.waves.length >= 4);

    const json = JSON.stringify({ workflowId: plan.workflowId, waves: plan.waves });
    assert.ok(json.length < 400, `Compiled wave plan must stay compact (< 400 bytes), got ${json.length}`);
  });

  it("TEST 2: ExecutionEngine.launch forwards inputs cleanly and runs zero billing logic during dev mode", async () => {
    let queuedPayload = null;
    const engine = new ExecutionEngine({
      identityTools: {
        assertOwns: async () => true,
        assertOwnsAny: async () => true,
      },
      jobQueueService: {
        addUseCaseJob: async (payload) => {
          queuedPayload = payload;
          return { id: "job-d23" };
        },
      },
    });

    const result = await engine.launch({
      useCaseId: "video-generation-v3",
      userId: "user-test-d23",
      executionId: "run-d23-test",
      workflowId: "wf-d23-test",
      input: {
        prompt: "Massive prompt ".repeat(300),
        model: "seedance_2_5",
        media_id: "media-d23",
        parameters: {
          input_image: "https://cdn.example.com/ref.jpg",
        },
      },
    });

    assert.equal(result.status, "queued");
    assert.equal(result.executionId, "run-d23-test");
    assert.equal(queuedPayload?.executionId, "run-d23-test");
    assert.equal(queuedPayload?.input?.media_id, "media-d23");
  });

  it("TEST 2b (H1): #billing/tools settleCredits & rollbackCredits pass { referenceId } reservation objects to real WalletService.settle / release (never raw strings)", async () => {
    const rpcCalls = [];
    const settleArgs = [];
    const releaseArgs = [];

    const realWallet = new WalletService("https://mock.supabase.co", "mock-service-key");
    realWallet.txRepo = {
      resolveTransactionRpc: async (fnName, referenceId) => {
        rpcCalls.push({ fnName, referenceId });
        return {
          tx: {
            reference_id: referenceId,
            status: fnName === "commit_transaction" ? "COMPLETED" : "FAILED",
          },
          error: null,
        };
      },
      mergeMetadata: async () => {},
      findByReference: async () => null,
    };

    const origSettle = realWallet.settle.bind(realWallet);
    const origRelease = realWallet.release.bind(realWallet);
    realWallet.settle = async (reservation, extraMetadata) => {
      settleArgs.push({ reservation, extraMetadata });
      return origSettle(reservation, extraMetadata);
    };
    realWallet.release = async (reservation, extraMetadata) => {
      releaseArgs.push({ reservation, extraMetadata });
      return origRelease(reservation, extraMetadata);
    };

    const settleRes = await settleCredits(
      { referenceId: "hold-h1-settle", metadata: { runId: "run-h1" } },
      { walletService: realWallet }
    );
    const rollbackRes = await rollbackCredits(
      { referenceId: "hold-h1-rollback", metadata: { reason: "provider_error" } },
      { walletService: realWallet }
    );
    // Also verify string shorthand wraps into { referenceId } object
    await settleCredits("hold-h1-str-settle", { walletService: realWallet });
    await rollbackCredits("hold-h1-str-rollback", { walletService: realWallet });

    assert.equal(settleRes.settled, true);
    assert.equal(settleRes.referenceId, "hold-h1-settle");
    assert.equal(rollbackRes.rolledBack, true);
    assert.equal(rollbackRes.referenceId, "hold-h1-rollback");

    assert.equal(settleArgs.length, 2);
    assert.equal(typeof settleArgs[0].reservation, "object");
    assert.equal(settleArgs[0].reservation.referenceId, "hold-h1-settle");
    assert.equal(typeof settleArgs[1].reservation, "object");
    assert.equal(settleArgs[1].reservation.referenceId, "hold-h1-str-settle");

    assert.equal(releaseArgs.length, 2);
    assert.equal(typeof releaseArgs[0].reservation, "object");
    assert.equal(releaseArgs[0].reservation.referenceId, "hold-h1-rollback");
    assert.equal(typeof releaseArgs[1].reservation, "object");
    assert.equal(releaseArgs[1].reservation.referenceId, "hold-h1-str-rollback");

    assert.deepEqual(rpcCalls, [
      { fnName: "commit_transaction", referenceId: "hold-h1-settle" },
      { fnName: "rollback_transaction", referenceId: "hold-h1-rollback" },
      { fnName: "commit_transaction", referenceId: "hold-h1-str-settle" },
      { fnName: "rollback_transaction", referenceId: "hold-h1-str-rollback" },
    ]);
  });

  it("TEST 3: WalletService.validateMetadata measures actual UTF-8 byte length (not UTF-16 string length)", () => {
    const wallet = new WalletService("https://mock.supabase.co", "mock-service-key");

    // 1500 4-byte unicode characters (e.g. 🎨 is 4 bytes in UTF-8, 2 chars in JS string)
    // String length = 3000 chars (<= 4096 JS string length)
    // UTF-8 byte length = 6000 bytes (> 4096 bytes!)
    const multiByteString = "🎨".repeat(1500);
    const multiByteMetadata = { note: multiByteString };

    const json = JSON.stringify(multiByteMetadata);
    assert.ok(json.length < 4096, `JS string length is ${json.length} which is <= 4096`);
    assert.ok(Buffer.byteLength(json, "utf8") > 4096, `UTF-8 byte length is ${Buffer.byteLength(json, "utf8")} which is > 4096`);

    // Under UTF-8 byte checking, this MUST throw INVALID_METADATA because it exceeds 4096 bytes
    assert.throws(
      () => wallet.validateMetadata(multiByteMetadata),
      (err) => {
        assert.equal(err.code, "INVALID_METADATA");
        assert.match(err.message, /Metadata too large \(max 4096 bytes\)/);
        return true;
      }
    );
  });
});
}
