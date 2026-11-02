process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../src/errors/AppError.js";
import {
    getCreditBalance,
    reserveCredits,
    settleCredits,
    rollbackCredits,
    addCredits,
    listTransactions,
    listCreditPackages,
    configureBilling,
    getBillingService,
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
} from "#platform/billing";

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
