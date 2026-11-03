process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WalletRepository } from "../../src/platform/billing/repositories/WalletRepository.js";
import { TransactionRepository } from "../../src/platform/billing/repositories/TransactionRepository.js";
import { FailedOpsRepository } from "../../src/platform/billing/repositories/FailedOpsRepository.js";
import { CreditPackageRepository } from "../../src/platform/billing/repositories/CreditPackageRepository.js";
import { WalletError, BillingError } from "../../src/platform/billing/BillingErrors.js";
import { createBillingRepositories } from "../../src/platform/billing/billingFactory.js";

function makeMockSupabase() {
    const rpcCalls = [];
    const tables = {
        wallets: new Map(),
        transactions: new Map(),
        failed_wallet_operations: new Map(),
        credit_packages: new Map(),
    };

    const client = {
        rpcCalls,
        tables,
        async rpc(fnName, params) {
            rpcCalls.push({ fnName, params });
            if (fnName === "hold_credits") {
                return {
                    data: {
                        id: `tx_${params.p_reference_id}`,
                        wallet_id: params.p_wallet_id,
                        amount: params.p_amount,
                        status: "PENDING",
                    },
                    error: null,
                };
            }
            if (fnName === "extend_hold") {
                return {
                    data: {
                        reference_id: params.p_reference_id,
                        status: "PENDING",
                        additional_seconds: params.p_additional_seconds,
                    },
                    error: null,
                };
            }
            if (fnName === "credit_wallet") {
                return {
                    data: {
                        id: `tx_${params.p_reference_id}`,
                        wallet_id: params.p_wallet_id,
                        amount: params.p_amount,
                        status: "COMPLETED",
                    },
                    error: null,
                };
            }
            if (fnName === "expire_stale_holds") {
                return {
                    data: 2,
                    error: null,
                };
            }
            if (fnName === "commit_transaction" || fnName === "rollback_transaction") {
                return {
                    data: { reference_id: params.p_reference_id, status: fnName === "commit_transaction" ? "COMPLETED" : "FAILED" },
                    error: null,
                };
            }
            return { data: null, error: null };
        },
        from(tableName) {
            const table = tables[tableName] || new Map();
            let query = {
                table,
                filters: {},
                inserted: null,
                updated: null,
                selected: "*",
                isSingle: false,
                isMaybeSingle: false,
                isDelete: false,
                orderBy: [],
                limitCount: null,
                orClause: null,
            };

            const builder = {
                select(fields = "*") {
                    query.selected = fields;
                    return builder;
                },
                insert(record) {
                    query.inserted = record;
                    return builder;
                },
                update(fields) {
                    query.updated = fields;
                    return builder;
                },
                delete() {
                    query.isDelete = true;
                    return builder;
                },
                eq(field, value) {
                    query.filters[field] = value;
                    return builder;
                },
                lt(field, value) {
                    query.filters[`${field}_lt`] = value;
                    return builder;
                },
                order(field, { ascending = true } = {}) {
                    query.orderBy.push({ field, ascending });
                    return builder;
                },
                limit(n) {
                    query.limitCount = n;
                    return builder;
                },
                or(clause) {
                    query.orClause = clause;
                    return builder;
                },
                single() {
                    query.isSingle = true;
                    return builder._execute();
                },
                maybeSingle() {
                    query.isMaybeSingle = true;
                    return builder._execute();
                },
                async then(resolve, reject) {
                    try {
                        const result = await builder._execute();
                        resolve(result);
                    } catch (e) {
                        reject(e);
                    }
                },
                async _execute() {
                    if (query.inserted) {
                        const record = { id: `id_${Date.now()}_${Math.random()}`, ...query.inserted };
                        table.set(record.id, record);
                        return { data: record, error: null };
                    }
                    if (query.updated) {
                        let matches = [...table.values()];
                        for (const [k, v] of Object.entries(query.filters)) {
                            matches = matches.filter((r) => r[k] === v);
                        }
                        for (const match of matches) {
                            Object.assign(match, query.updated);
                        }
                        if (query.isMaybeSingle || query.isSingle) {
                            return { data: matches[0] || null, error: null, count: matches.length };
                        }
                        return { data: matches, error: null, count: matches.length };
                    }
                    if (query.isDelete) {
                        for (const [k, v] of Object.entries(query.filters)) {
                            for (const [id, r] of table.entries()) {
                                if (r[k] === v) table.delete(id);
                            }
                        }
                        return { data: null, error: null };
                    }

                    let matches = [...table.values()];
                    for (const [k, v] of Object.entries(query.filters)) {
                        matches = matches.filter((r) => r[k] === v);
                    }
                    if (query.limitCount) {
                        matches = matches.slice(0, query.limitCount);
                    }
                    if (query.isMaybeSingle || query.isSingle) {
                        return { data: matches[0] || null, error: null };
                    }
                    return { data: matches, error: null };
                },
            };
            return builder;
        },
    };
    return client;
}

describe("Billing Business System — Private Repositories (Phase 2.2 & 2.4)", () => {
    describe("WalletRepository", () => {
        it("fails closed on missing supabaseClient", () => {
            assert.throws(() => new WalletRepository(), /supabaseClient is required/);
        });

        it("creates a wallet and queries by user_id and id", async () => {
            const client = makeMockSupabase();
            const repo = new WalletRepository(client);

            const wallet = await repo.createOrEnsureWallet("user-100", 50);
            assert.equal(wallet.user_id, "user-100");
            assert.equal(wallet.balance, 50);

            const byUser = await repo.findByUserId("user-100");
            assert.equal(byUser.id, wallet.id);

            const byId = await repo.findById(wallet.id);
            assert.equal(byId.user_id, "user-100");
        });

        it("executes credit_wallet RPC", async () => {
            const client = makeMockSupabase();
            const repo = new WalletRepository(client);

            const { tx, error } = await repo.creditWalletRpc({
                walletId: "w-1",
                amount: 100,
                referenceId: "ref-credit-1",
            });

            assert.equal(error, null);
            assert.equal(tx.amount, 100);
            assert.equal(client.rpcCalls.length, 1);
            assert.equal(client.rpcCalls[0].fnName, "credit_wallet");
        });

        it("supports optimistic increment and decrement balance updates", async () => {
            const client = makeMockSupabase();
            const repo = new WalletRepository(client);

            const w = await repo.createOrEnsureWallet("user-200", 100);

            const decResult = await repo.decrementBalanceOptimistic(w.id, 30, 100);
            assert.equal(decResult.ok, true);
            assert.equal(decResult.newBalance, 70);

            const incResult = await repo.incrementBalanceOptimistic(w.id, 20, 70);
            assert.equal(incResult.ok, true);
            assert.equal(incResult.newBalance, 90);
        });
    });

    describe("TransactionRepository", () => {
        it("fails closed on missing supabaseClient", () => {
            assert.throws(() => new TransactionRepository(), /supabaseClient is required/);
        });

        it("executes hold_credits and extend_hold RPCs with exact parameters", async () => {
            const client = makeMockSupabase();
            const repo = new TransactionRepository(client);

            const { tx, error } = await repo.holdCreditsRpc({
                walletId: "w-10",
                amount: 25,
                referenceId: "ref-hold-1",
                expiresAt: "2026-11-02T22:00:00Z",
            });

            assert.equal(error, null);
            assert.equal(tx.status, "PENDING");
            assert.equal(client.rpcCalls[0].fnName, "hold_credits");
            assert.equal(client.rpcCalls[0].params.p_amount, 25);

            const ext = await repo.extendHoldRpc({
                referenceId: "ref-hold-1",
                additionalSeconds: 120,
            });
            assert.equal(ext.error, null);
            assert.equal(client.rpcCalls[1].fnName, "extend_hold");
            assert.equal(client.rpcCalls[1].params.p_additional_seconds, 120);
        });

        it("executes expire_stale_holds RPC", async () => {
            const client = makeMockSupabase();
            const repo = new TransactionRepository(client);

            const res = await repo.expireStaleHoldsRpc();
            assert.equal(res.error, null);
            assert.equal(res.data, 2);
        });

        it("inserts, updates and queries transactions", async () => {
            const client = makeMockSupabase();
            const repo = new TransactionRepository(client);

            const { tx } = await repo.insertTransaction({
                wallet_id: "w-50",
                amount: 15,
                type: "DEBIT",
                status: "PENDING",
                reference_id: "ref-custom-1",
            });
            assert.equal(tx.amount, 15);

            const found = await repo.findByReference("ref-custom-1");
            assert.equal(found.reference_id, "ref-custom-1");

            const lockRes = await repo.updateStatusWithOptimisticLock({
                id: tx.id,
                fromStatus: "PENDING",
                toStatus: "COMPLETED",
            });
            assert.equal(lockRes.data.status, "COMPLETED");
        });
    });

    describe("FailedOpsRepository", () => {
        it("fails closed on missing supabaseClient", () => {
            assert.throws(() => new FailedOpsRepository(), /supabaseClient is required/);
        });

        it("inserts failed op, marks completed and marks abandoned", async () => {
            const client = makeMockSupabase();
            const repo = new FailedOpsRepository(client);

            const existingNone = await repo.findExisting("ref-failed-1", "COMMIT");
            assert.equal(existingNone, null);

            await repo.insertFailedOp({
                operation_type: "COMMIT",
                reference_id: "ref-failed-1",
                user_id: "u-1",
                amount: 10,
                status: "PENDING",
            });

            const existing = await repo.findExisting("ref-failed-1", "COMMIT");
            assert.ok(existing);

            await repo.markCompleted(existing.id);
            const table = client.tables.failed_wallet_operations;
            assert.equal(table.get(existing.id).status, "COMPLETED");

            await repo.markAbandoned(existing.id, "Max retries reached");
            assert.equal(table.get(existing.id).status, "ABANDONED");
        });
    });

    describe("CreditPackageRepository", () => {
        it("returns empty array or package list on active query", async () => {
            const client = makeMockSupabase();
            const repo = new CreditPackageRepository(client);

            const empty = await repo.listActivePackages();
            assert.deepEqual(empty, []);

            const table = client.tables.credit_packages;
            table.set("pkg-1", {
                id: "pkg-1",
                label: "Starter",
                credits: 100,
                price: 10,
                variant_id: "var-100",
                is_active: true,
                sort_order: 1,
            });
            table.set("pkg-2", {
                id: "pkg-2",
                label: "Pro",
                credits: 500,
                price: 45,
                variant_id: "var-500",
                is_active: false,
                sort_order: 2,
            });

            const active = await repo.listActivePackages();
            assert.equal(active.length, 1);
            assert.equal(active[0].id, "pkg-1");
        });

        it("finds active package by id", async () => {
            const client = makeMockSupabase();
            const repo = new CreditPackageRepository(client);

            const table = client.tables.credit_packages;
            table.set("pkg-100", { id: "pkg-100", credits: 100, is_active: true });

            const found = await repo.findActiveById("pkg-100");
            assert.ok(found);
            assert.equal(found.credits, 100);

            const missing = await repo.findActiveById("non-existent");
            assert.equal(missing, null);
        });

        it("finds credits amount by variant ID and package ID", async () => {
            const client = makeMockSupabase();
            const repo = new CreditPackageRepository(client);

            const table = client.tables.credit_packages;
            table.set("pkg-100", { id: "pkg-100", variant_id: "v-100", credits: 100, is_active: true });

            const creditsByVar = await repo.findCreditsByVariantId("v-100");
            assert.equal(creditsByVar, 100);

            const creditsById = await repo.findCreditsById("pkg-100");
            assert.equal(creditsById, 100);

            const missing = await repo.findCreditsByVariantId("v-unknown");
            assert.equal(missing, null);
        });

        it("fails closed when instantiated without supabaseClient", () => {
            assert.throws(
                () => new CreditPackageRepository(),
                (err) => err instanceof BillingError && /supabaseClient is required/.test(err.message)
            );
        });
    });

    describe("createBillingRepositories (Factory Wiring)", () => {
        it("returns null when admin client is missing", () => {
            assert.equal(createBillingRepositories(null), null);
        });

        it("throws BillingError fail-closed when catalogClient is missing", () => {
            const adminClient = makeMockSupabase();
            assert.throws(
                () => createBillingRepositories(adminClient),
                (err) => err instanceof BillingError && /catalogClient is required/.test(err.message)
            );
        });

        it("wires catalogClient to CreditPackageRepository and returns both transactionRepo and txRepo alias", () => {
            const adminClient = makeMockSupabase();
            const catalogClient = makeMockSupabase();

            const repos = createBillingRepositories(adminClient, { catalogClient });
            assert.ok(repos.creditPackageRepo instanceof CreditPackageRepository);
            assert.equal(repos.creditPackageRepo._client, catalogClient, "CreditPackageRepository must be wired with the catalogClient");
            assert.equal(repos.walletRepo.supabase, adminClient, "WalletRepository must be wired with admin client");
            assert.ok(repos.transactionRepo instanceof TransactionRepository);
            assert.equal(repos.txRepo, repos.transactionRepo, "txRepo alias must strictly match transactionRepo");
        });
    });
});
