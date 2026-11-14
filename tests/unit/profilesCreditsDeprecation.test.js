import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";
import { signup, getWalletBalance } from "#identity/api";
import { walletService } from "../../src/container.js";
import { WorkflowRepository } from "#generation/tools";
import { ProjectReadService } from "#workspace/tools";

describe("profiles.credits & workflow.variation_index Deprecation Verification", () => {
  it("signup: createProfile does not write credits to profiles table (isolated mocks)", async () => {
    let capturedUpsertPayload = null;
    const origFrom = supabase.from;
    const origAdminFrom = supabaseAdmin.from;
    const origSignUp = supabase.auth.signUp;
    const origEnsureWallet = walletService?.ensureWallet;

    try {
      supabase.from = (table) => {
        if (table === "profiles") {
          return {
            upsert: async (payload) => {
              capturedUpsertPayload = payload;
              return { data: [{ ...payload }], error: null };
            },
          };
        }
        return origFrom.call(supabase, table);
      };

      if (walletService) {
        walletService.ensureWallet = async () => ({ id: "w-mock-1", balance: 500 });
      }

      supabase.auth.signUp = async () => ({
        data: {
          user: { id: "00000000-0000-4000-a000-000000000001" },
          session: { access_token: "mock", refresh_token: "mock" },
        },
        error: null,
      });

      const mockReq = {
        body: { email: "test-deprecation@example.com", password: "password123" },
      };
      let responseStatus = 200;
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return mockRes;
        },
        json: () => mockRes,
        cookie: () => {},
      };

      await signup(mockReq, mockRes);

      assert.equal(responseStatus, 201);
      assert.ok(capturedUpsertPayload, "Profiles upsert was called");
      assert.equal(capturedUpsertPayload.id, "00000000-0000-4000-a000-000000000001");
      assert.equal(
        "credits" in capturedUpsertPayload,
        false,
        "profiles.credits MUST NOT be populated during signup"
      );
    } finally {
      supabase.from = origFrom;
      supabaseAdmin.from = origAdminFrom;
      supabase.auth.signUp = origSignUp;
      if (walletService && origEnsureWallet) {
        walletService.ensureWallet = origEnsureWallet;
      }
    }
  });

  it("test isolation verification: supabase.auth.signUp and db mocks are restored in finally even on throw", async () => {
    const origFrom = supabase.from;
    const origAdminFrom = supabaseAdmin.from;
    const origSignUp = supabase.auth.signUp;
    const origEnsureWallet = walletService?.ensureWallet;

    let caughtError = null;
    try {
      try {
        supabase.auth.signUp = async () => ({
          data: { user: { id: "00000000-0000-4000-a000-000000000001" }, session: null },
          error: null,
        });
        supabase.from = () => ({
          upsert: async () => ({ data: [], error: null }),
        });
        if (walletService) {
          walletService.ensureWallet = async () => ({ id: "w-mock-1", balance: 500 });
        }

        const mockReq = { body: { email: "test-fail@example.com", password: "password123" } };
        const mockRes = {
          status: () => {
            throw new Error("UNHANDLED_EXCEPTION_IN_TEST_CALLBACK");
          },
          json: () => mockRes,
          cookie: () => {},
        };

        await signup(mockReq, mockRes);
      } finally {
        supabase.from = origFrom;
        supabaseAdmin.from = origAdminFrom;
        supabase.auth.signUp = origSignUp;
        if (walletService && origEnsureWallet) {
          walletService.ensureWallet = origEnsureWallet;
        }
      }
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "An error was thrown as expected");
    assert.equal(caughtError.message, "UNHANDLED_EXCEPTION_IN_TEST_CALLBACK");
    assert.strictEqual(supabase.auth.signUp, origSignUp, "supabase.auth.signUp must be strictly restored");
    assert.strictEqual(supabase.from, origFrom, "supabase.from must be strictly restored");
    assert.strictEqual(supabaseAdmin.from, origAdminFrom, "supabaseAdmin.from must be strictly restored");
    if (walletService && origEnsureWallet) {
      assert.strictEqual(walletService.ensureWallet, origEnsureWallet, "walletService.ensureWallet must be strictly restored");
    }
  });

  it("wallet balance retrieval: getWalletBalance controller delegates to real WalletService and NEVER accesses profiles table", async () => {
    const origGetUser = supabase.auth.getUser;
    const origWalletFrom = walletService.supabase.from;

    const tablesQueried = [];

    try {
      const mockTableAccess = (table) => {
        tablesQueried.push(table);
        if (table === "wallets") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "w-1", user_id: "user-wallet-123", balance: 750 },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "profiles") {
          throw new Error("VIOLATION: profiles table was queried during wallet balance retrieval!");
        }
        return origWalletFrom.call(walletService.supabase, table);
      };

      // Instrument the actual database client used by WalletService
      walletService.supabase.from = mockTableAccess;

      supabase.auth.getUser = async () => ({
        data: { user: { id: "user-wallet-123", email: "wallet@example.com" } },
        error: null,
      });

      let responseStatus = 200;
      let responseBody = null;
      const mockReq = {
        cookies: { access_token: "valid-jwt-token" }, // gate:allow-secret
      };
      const mockRes = {
        status: (code) => {
          responseStatus = code;
          return mockRes;
        },
        json: (data) => {
          responseBody = data;
          return mockRes;
        },
        clearCookie: () => {},
      };

      // Call the actual controller using the real WalletService.getBalance
      await getWalletBalance(mockReq, mockRes);

      assert.equal(responseStatus, 200);
      assert.deepEqual(responseBody, { balance: 750 });

      // Explicit assertion proving profiles is never queried
      assert.equal(
        tablesQueried.includes("profiles"),
        false,
        "profiles table MUST NEVER be queried during getWalletBalance"
      );
      assert.equal(tablesQueried.filter((t) => t === "profiles").length, 0);
      assert.ok(tablesQueried.includes("wallets"), "wallets table must be the authoritative source queried");
    } finally {
      supabase.auth.getUser = origGetUser;
      walletService.supabase.from = origWalletFrom;
    }
  });

  it("WalletService.getBalance: actual service implementation directly queries wallets table and NEVER profiles", async () => {
    const origWalletFrom = walletService.supabase.from;
    const tablesQueried = [];

    try {
      walletService.supabase.from = (table) => {
        tablesQueried.push(table);
        if (table === "wallets") {
          return {
            select: () => ({
              eq: (col, val) => ({
                maybeSingle: async () => {
                  assert.equal(col, "user_id");
                  assert.equal(val, "user-actual-balance-check");
                  return {
                    data: { id: "w-real-999", user_id: val, balance: 1250 },
                    error: null,
                  };
                },
              }),
            }),
          };
        }
        if (table === "profiles") {
          throw new Error("VIOLATION: WalletService directly queried profiles table for balance!");
        }
        return origWalletFrom.call(walletService.supabase, table);
      };

      const balance = await walletService.getBalance("user-actual-balance-check");

      assert.equal(balance, 1250);
      assert.equal(
        tablesQueried.includes("profiles"),
        false,
        "WalletService.getBalance MUST NOT read from profiles"
      );
      assert.deepEqual(tablesQueried, ["wallets"], "WalletService MUST ONLY query wallets table");
    } finally {
      walletService.supabase.from = origWalletFrom;
    }
  });

  it("workflow creation: WorkflowRepository.createWorkflow does NOT insert variation_index", async () => {
    let insertedPayload = null;
    const repo = new WorkflowRepository();
    const origFrom = supabase.from;

    try {
      supabase.from = (table) => {
        if (table === "workflow") {
          return {
            insert: (payload) => {
              insertedPayload = payload;
              return {
                select: () => ({
                  single: async () => ({ data: { id: "wf-1", ...payload }, error: null }),
                  then: (resolve) => resolve({ data: [{ id: "wf-1", ...payload }], error: null }),
                }),
              };
            },
          };
        }
        return origFrom.call(supabase, table);
      };

      await repo.createWorkflow({
        project_id: "00000000-0000-4000-a000-000000000001",
        display_name: "Workflow Without Variation Index",
        workflow_type: "GENERATION",
      });

      assert.ok(insertedPayload, "Workflow insert called");
      assert.equal(
        "variation_index" in insertedPayload,
        false,
        "workflow.variation_index MUST NOT be present in insert payload"
      );
    } finally {
      supabase.from = origFrom;
    }
  });

  it("workflow listing: findByProjectsPaginated orders by create_time DESC and does NOT select variation_index", async () => {
    let capturedSelect = null;
    let capturedOrderColumn = null;
    let capturedOrderAscending = null;

    const repo = new WorkflowRepository();
    const origClient = repo.client;

    try {
      repo.client = () => ({
        from: (table) => ({
          select: (cols, opts) => {
            if (table === "trash") {
              return {
                in: async () => ({ data: [], error: null }),
              };
            }
            if (opts?.count) {
              return {
                in: () => ({ count: 1, error: null }),
              };
            }
            if (cols === "id") {
              return {
                in: async () => ({ data: [{ id: "wf-1" }], error: null }),
              };
            }
            capturedSelect = cols;
            return {
              in: () => ({
                order: (col, { ascending }) => {
                  capturedOrderColumn = col;
                  capturedOrderAscending = ascending;
                  return {
                    range: async () => ({
                      data: [
                        {
                          id: "wf-1",
                          project_id: "00000000-0000-4000-a000-000000000001",
                          display_name: "WF 1",
                          favorited: false,
                          workflow_type: "GENERATION",
                          create_time: "2026-01-01T00:00:00Z",
                        },
                      ],
                      error: null,
                    }),
                  };
                },
              }),
            };
          },
        }),
      });

      const result = await repo.findByProjectsPaginated(["00000000-0000-4000-a000-000000000001"]);
      assert.equal(result.total, 1);
      assert.equal(result.workflows.length, 1);
      assert.ok(capturedSelect, "Select query was executed");
      assert.equal(
        capturedSelect.includes("variation_index"),
        false,
        "findByProjectsPaginated MUST NOT request variation_index from DB"
      );
      assert.equal(capturedOrderColumn, "create_time", "findByProjectsPaginated must order by create_time");
      assert.equal(capturedOrderAscending, false, "findByProjectsPaginated must order descending (newest first)");
    } finally {
      repo.client = origClient;
    }
  });

  it("WorkflowRepository: findByBatch is completely removed as obsolete", () => {
    const repo = new WorkflowRepository();
    assert.equal(
      typeof repo.findByBatch,
      "undefined",
      "WorkflowRepository.findByBatch must be completely removed"
    );
  });

  it("project-data response: ProjectReadService does NOT select variation_index and orders workflows by create_time DESC", async () => {
    let capturedWorkflowSelect = null;
    let capturedWorkflowOrder = null;

    const mockDb = {
      workflows: {
        findByProject: async (pid, options) => {
          capturedWorkflowSelect = options?.select;
          capturedWorkflowOrder = options?.order;
          return [
            {
              id: "00000000-0000-4000-a000-000000000010",
              display_name: "WF 1",
              create_time: "2026-01-01T00:00:00Z",
              workflow_type: "GENERATION",
              folder_id: null,
              favorited: false,
            },
          ];
        },
      },
      characters: { findByProject: async () => [] },
      elements: { findByProject: async () => [] },
    };

    const origFrom = supabase.from;
    const origAdminFrom = supabaseAdmin.from;

    const mockFrom = (table) => {
      if (table === "project") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { id: "00000000-0000-4000-a000-000000000001", user_id: "00000000-0000-4000-a000-000000000002", project_name: "Test" }, error: null }),
            }),
          }),
        };
      }
      if (table === "media" || table === "workflow_media") {
        return {
          select: () => ({
            eq: () => ({ order: async () => ({ data: [], error: null }) }),
            in: async () => ({ data: [], error: null }),
          }),
        };
      }
      if (table === "element" || table === "characters") {
        return {
          select: () => ({
            in: async () => ({ data: [], error: null }),
            eq: async () => ({ data: [], error: null }),
            or: async () => ({ data: [], error: null }),
          }),
        };
      }
      return origFrom.call(supabase, table);
    };

    try {
      supabase.from = mockFrom;
      supabaseAdmin.from = mockFrom;

      const service = new ProjectReadService({ db: mockDb });
      const data = await service.getProjectData({
        projectId: "00000000-0000-4000-a000-000000000001",
        userId: "00000000-0000-4000-a000-000000000002",
      });

      assert.equal(data.projectId, "00000000-0000-4000-a000-000000000001");
      assert.equal(data.workflows.length, 1);
      assert.ok(capturedWorkflowSelect, "findByProject was called with select options");
      assert.equal(
        capturedWorkflowSelect.includes("variation_index"),
        false,
        "ProjectReadService MUST NOT request variation_index"
      );
      assert.deepEqual(
        capturedWorkflowOrder,
        { column: "create_time", ascending: false },
        "ProjectReadService must request workflows ordered by create_time DESC"
      );
    } finally {
      supabase.from = origFrom;
      supabaseAdmin.from = origAdminFrom;
    }
  });
});
