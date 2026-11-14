import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WalletService, createWalletService, WalletError, WalletRepository, TransactionRepository, FailedOpsRepository, CreditPackageRepository, BillingError, createBillingRepositories } from "#billing/tools";

// ─── Source: atomicWalletHoldRPCsBoundary.test.js ───
{
describe("Ticket 06: Atomic Wallet Hold RPCs Boundary Tests (Hardened)", () => {

  // ─────────────────────────────────────────────────────────────────────────
  // SEAM 1: extendHold RPC Integration, Validation & Expiration Boundary
  // ─────────────────────────────────────────────────────────────────────────

  it("TEST 1: extendHold invokes extend_hold RPC with normalized parameters and returns updated record", async () => {
    const rpcCalls = [];
    const mockSupabase = {
      rpc: async (fnName, params) => {
        rpcCalls.push({ fnName, params });
        if (fnName === "extend_hold") {
          return {
            data: {
              id: "tx-uuid-1",
              reference_id: params.p_reference_id,
              status: "PENDING",
              expires_at: new Date(Date.now() + params.p_additional_seconds * 1000).toISOString(),
            },
            error: null,
          };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const res = await wallet.extendHold("hold-ref-123", 600);

    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fnName, "extend_hold");
    assert.equal(rpcCalls[0].params.p_reference_id, "hold-ref-123");
    assert.equal(rpcCalls[0].params.p_additional_seconds, 600);
    assert.equal(res.reference_id, "hold-ref-123");
    assert.equal(res.status, "PENDING");
  });

  it("TEST 2: extendHold rejects empty referenceId before calling RPC", async () => {
    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    const res = await wallet.extendHold(null, 300);
    assert.equal(res, null);

    const res2 = await wallet.extendHold("", 300);
    assert.equal(res2, null);

    const res3 = await wallet.extendHold("   ", 300);
    assert.equal(res3, null);
  });

  it("TEST 3: extendHold surfaces database error when RPC raises non-pending or not-found exception", async () => {
    const mockSupabase = {
      rpc: async () => ({
        data: null,
        error: { message: "Cannot extend transaction with status COMPLETED", code: "P0001" },
      }),
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    await assert.rejects(
      async () => wallet.extendHold("hold-completed-1", 300),
      (err) => {
        assert.match(err.message, /Cannot extend transaction with status COMPLETED/);
        return true;
      }
    );
  });

  it("TEST 4: extendHold rejects attempts to resurrect already expired holds (expires_at <= now())", async () => {
    const mockSupabase = {
      rpc: async (fnName, params) => {
        return {
          data: null,
          error: {
            message: `Cannot extend expired transaction ${params.p_reference_id} (expired at 2026-10-18T16:00:00.000Z)`,
            code: "P0001",
          },
        };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    await assert.rejects(
      async () => wallet.extendHold("hold-expired-earlier", 300),
      (err) => {
        assert.match(err.message, /Cannot extend expired transaction/);
        return true;
      }
    );
  });

  it("TEST 5: extendHold surfaces ambiguous match error if duplicate matches are detected", async () => {
    const mockSupabase = {
      rpc: async () => ({
        data: null,
        error: {
          message: "Ambiguous transaction match: multiple records found for reference_id hold-dup",
          code: "P0003",
        },
      }),
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    await assert.rejects(
      async () => wallet.extendHold("hold-dup", 300),
      /Ambiguous transaction match/
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEAM 2: expireStaleHolds RPC Integration, Predicates & Subtransactions
  // ─────────────────────────────────────────────────────────────────────────

  it("TEST 6: expireStaleHolds invokes expire_stale_holds RPC and returns count of expired records", async () => {
    const rpcCalls = [];
    const mockRecords = [
      { id: "tx-1", reference_id: "ref-1", amount: 10, status: "FAILED", wallet_id: "w-1" },
      { id: "tx-2", reference_id: "ref-2", amount: 20, status: "FAILED", wallet_id: "w-2" },
    ];

    const mockSupabase = {
      rpc: async (fnName) => {
        rpcCalls.push(fnName);
        if (fnName === "expire_stale_holds") {
          return { data: mockRecords, error: null };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const count = await wallet.expireStaleHolds();

    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0], "expire_stale_holds");
    assert.equal(count, 2, "expireStaleHolds must return the numeric count of expired holds");
  });

  it("TEST 7: expireStaleHolds returns 0 when no holds expired (empty array from RPC)", async () => {
    const mockSupabase = {
      rpc: async (fnName) => {
        if (fnName === "expire_stale_holds") {
          return { data: [], error: null };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const count = await wallet.expireStaleHolds();
    assert.equal(count, 0);
  });

  it("TEST 8: Subtransaction error isolation: malformed row in batch does not block valid refunds", async () => {
    // In SQL, row 1 succeeds, row 2 hits missing wallet (caught in subtransaction), row 3 succeeds.
    // RPC returns only the successfully refunded transactions (rows 1 and 3).
    const mockRecords = [
      { id: "tx-good-1", reference_id: "ref-good-1", amount: 10, status: "FAILED", wallet_id: "w-1" },
      { id: "tx-good-3", reference_id: "ref-good-3", amount: 25, status: "FAILED", wallet_id: "w-3" },
    ];

    const mockSupabase = {
      rpc: async (fnName) => {
        if (fnName === "expire_stale_holds") {
          return { data: mockRecords, error: null };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const count = await wallet.expireStaleHolds();
    assert.equal(count, 2, "Valid holds in batch must succeed despite malformed siblings");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEAM 3: reapExpiredHolds Structured Reconciliation
  // ─────────────────────────────────────────────────────────────────────────

  it("TEST 9: reapExpiredHolds uses atomic RPC and extracts correlation IDs for domain reconciliation", async () => {
    const mockRecords = [
      {
        id: "tx-reap-1",
        reference_id: "hold-user-1",
        wallet_id: "wallet-1",
        amount: 30,
        status: "FAILED",
        metadata: { workflowId: "wf-reap-100", mediaId: "media-reap-200" },
      },
    ];

    const mockSupabase = {
      rpc: async (fnName) => {
        if (fnName === "expire_stale_holds") {
          return { data: mockRecords, error: null };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const reaped = await wallet.reapExpiredHolds();

    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].holdId, "hold-user-1");
    assert.equal(reaped[0].workflowId, "wf-reap-100");
    assert.equal(reaped[0].mediaId, "media-reap-200");
    assert.equal(reaped[0].amount, 30);
    assert.equal(reaped[0].walletId, "wallet-1");
    assert.equal(reaped[0].transactionId, "tx-reap-1");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEAM 4: Concurrency & Race Scenarios (Simulation)
  // ─────────────────────────────────────────────────────────────────────────

  it("TEST 10: Concurrent workers running expireStaleHolds do not double-process (SKIP LOCKED simulation)", async () => {
    let callCount = 0;
    const mockSupabase = {
      rpc: async (fnName) => {
        if (fnName === "expire_stale_holds") {
          callCount++;
          if (callCount === 1) {
            return {
              data: [
                { id: "tx-c1", reference_id: "ref-c1", amount: 10, status: "FAILED", wallet_id: "w-1" },
              ],
              error: null,
            };
          }
          return { data: [], error: null };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet1 = new WalletService("https://mock.supabase.co", "mock-key");
    wallet1.supabase = mockSupabase;

    const wallet2 = new WalletService("https://mock.supabase.co", "mock-key");
    wallet2.supabase = mockSupabase;

    const [result1, result2] = await Promise.all([
      wallet1.expireStaleHolds(),
      wallet2.expireStaleHolds(),
    ]);

    assert.equal(result1 + result2, 1, "Exactly 1 hold must be claimed across both concurrent workers");
    assert.equal(callCount, 2);
  });

  it("TEST 11: Race between extendHold and reaper: if reaper marks hold FAILED first, extendHold rejects", async () => {
    let holdStatus = "PENDING";

    const mockSupabase = {
      rpc: async (fnName, params) => {
        if (fnName === "expire_stale_holds") {
          holdStatus = "FAILED";
          return {
            data: [{ id: "tx-race-1", reference_id: "hold-race-1", status: "FAILED", amount: 10 }],
            error: null,
          };
        }
        if (fnName === "extend_hold") {
          if (holdStatus !== "PENDING") {
            return {
              data: null,
              error: { message: `Cannot extend transaction with status ${holdStatus}`, code: "P0001" },
            };
          }
          return {
            data: { id: "tx-race-1", reference_id: params.p_reference_id, status: "PENDING" },
            error: null,
          };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const expiredCount = await wallet.expireStaleHolds();
    assert.equal(expiredCount, 1);

    await assert.rejects(
      async () => wallet.extendHold("hold-race-1", 300),
      /Cannot extend transaction with status FAILED/
    );
  });

  it("TEST 12: RPC fallback: when RPC is missing from PostgREST schema cache (PGRST202), gracefully falls back", async () => {
    let fallbackUsed = false;
    const mockSupabase = {
      rpc: async (fnName) => {
        return {
          data: null,
          error: { message: `function ${fnName} not found in schema cache`, code: "PGRST202" },
        };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    wallet.expireStaleHoldsFallback = async () => {
      fallbackUsed = true;
      return 0;
    };

    const count = await wallet.expireStaleHolds();
    assert.equal(fallbackUsed, true, "Fallback must be called when RPC returns PGRST202");
    assert.equal(count, 0);
  });

  it("TEST 13: extendHold surfaces error when transaction is quarantined", async () => {
    const mockSupabase = {
      rpc: async (fnName, params) => {
        if (fnName === "extend_hold") {
          return {
            data: null,
            error: {
              message: `Cannot extend quarantined transaction ${params.p_reference_id}`,
              code: "P0001",
            },
          };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    await assert.rejects(
      async () => wallet.extendHold("hold-quarantined", 300),
      /Cannot extend quarantined transaction hold-quarantined/
    );
  });

  it("TEST 14: reapExpiredHolds skips holds when all are quarantined or in retry backoff", async () => {
    const mockSupabase = {
      rpc: async (fnName) => {
        if (fnName === "expire_stale_holds") {
          return { data: [], error: null };
        }
        return { data: null, error: { message: "unknown rpc" } };
      },
    };

    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    wallet.supabase = mockSupabase;

    const reaped = await wallet.reapExpiredHolds();
    assert.deepEqual(reaped, []);
  });
});
}

// ─── Source: walletServiceIdempotency.test.js ───
{
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
}

// ─── Source: billingRepositories.test.js ───
{
process.env.NODE_ENV = "test";


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
}
after(() => {
  setTimeout(() => process.exit(0), 100);
});
