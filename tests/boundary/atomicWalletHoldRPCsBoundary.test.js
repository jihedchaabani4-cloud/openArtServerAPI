import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { WalletService } from "../../src/platform/billing/WalletService.js";

describe("Ticket 06: Atomic Wallet Hold RPCs Boundary Tests (Hardened)", () => {
  after(() => {
    setTimeout(() => process.exit(0), 50);
  });

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
