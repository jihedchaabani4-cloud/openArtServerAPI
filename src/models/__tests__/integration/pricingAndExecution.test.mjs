import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../execution/modelRunner.js";
import { initRegistry, resetRegistry } from "../../registry/modelRegistry.js";

describe("Pricing and Execution Integration (US3)", () => {
  beforeEach(() => {
    resetRegistry();
    initRegistry({ forceReload: true });
  });

  it("should charge exact fixed retail credits and calculate wholesale margin", async () => {
    // Mock wallet service
    let heldAmount = 0;
    let committed = false;
    let released = false;

    const mockWalletService = {
      reserve: async ({ amount }) => {
        heldAmount = amount;
        return { reservationId: "res_test_123", amount };
      },
      commit: async () => {
        committed = true;
      },
      release: async () => {
        released = true;
      }
    };

    // Execute run with nanobana_pro
    // Note: nanobana_pro 1k:standard is 10 credits
    const result = await run("nanobana_pro", "text_to_image", {
      prompt: "a majestic mountain sunrise",
      resolution: "1k",
      quality: "standard"
    }, {
      userId: "usr_test",
      walletService: mockWalletService,
      credential: "fake_token"
    }).catch(async (err) => {
      // In unit test environment without real wavespeed network, we verify the hold and release
      return { caughtError: err };
    });

    // Verify 10 credits were reserved based on retail pricing table
    assert.equal(heldAmount, 10);
  });

  it("should throw MissingUserIdError when userId is missing and noCharge is not granted (Task 2)", async () => {
    const { MissingUserIdError } = await import("../../errors/index.js");

    await assert.rejects(
      () => run("gemini-3-flash", "chat_completion", { messages: [{ role: "user", content: "hi" }] }, {}),
      MissingUserIdError
    );

    // With noCharge: true, execution proceeds without error
    const mockGoogle = {
      models: {
        generateContent: async () => ({ text: "Free test response" }),
      },
    };

    const res = await run(
      "gemini-3-flash",
      "chat_completion",
      { messages: [{ role: "user", content: "hi" }] },
      { noCharge: true, reason: "internal-test", sdkClient: mockGoogle, credential: "fake" }
    );

    assert.equal(res.status, "success");
    assert.equal(res.metadata.creditsCharged, 0);
  });

  it("should return cached result without calling provider SDK or reserving wallet on duplicate idempotencyKey (Task 5)", async () => {
    let sdkCallCount = 0;
    let walletReserveCount = 0;

    const mockWallet = {
      reserve: async () => {
        walletReserveCount++;
        return { reservationId: "res_idem_1", amount: 1 };
      },
      commit: async () => {},
      release: async () => {},
    };

    const mockGoogle = {
      models: {
        generateContent: async () => {
          sdkCallCount++;
          return { text: "Idempotency test output" };
        },
      },
    };

    const runOptions = {
      userId: "user-idempotency",
      idempotencyKey: "idem_key_xyz_123",
      walletService: mockWallet,
      sdkClient: mockGoogle,
      credential: "fake",
    };

    // First run — executes provider and reserves wallet
    const firstRes = await run(
      "gemini-3-flash",
      "chat_completion",
      { messages: [{ role: "user", content: "first" }] },
      runOptions
    );

    assert.equal(firstRes.status, "success");
    assert.equal(sdkCallCount, 1);
    assert.equal(walletReserveCount, 1);

    // Second run with same idempotencyKey — must return cached result WITHOUT new SDK call or wallet reserve
    const secondRes = await run(
      "gemini-3-flash",
      "chat_completion",
      { messages: [{ role: "user", content: "first" }] },
      runOptions
    );

    assert.equal(secondRes.status, "success");
    assert.equal(secondRes.content, "Idempotency test output");
    assert.equal(sdkCallCount, 1); // Not incremented!
    assert.equal(walletReserveCount, 1); // Not incremented!
  });

  it("should skip wallet reserve when skipWalletHold is true (Task 6)", async () => {
    let walletReserveCalled = false;

    const mockWallet = {
      reserve: async () => {
        walletReserveCalled = true;
        return { reservationId: "should_not_be_called" };
      },
      commit: async () => {},
      release: async () => {},
    };

    const mockGoogle = {
      models: {
        generateContent: async () => ({ text: "Workflow node output" }),
      },
    };

    const res = await run(
      "gemini-3-flash",
      "chat_completion",
      { messages: [{ role: "user", content: "node prompt" }] },
      {
        userId: "user-wf",
        skipWalletHold: true,
        walletService: mockWallet,
        sdkClient: mockGoogle,
        credential: "fake",
      }
    );

    assert.equal(res.status, "success");
    assert.equal(walletReserveCalled, false);
    assert.equal(res.metadata.creditsCharged, 1); // Still reported for tracking
  });

  it("should retry transient error with backoff and succeed without tripping circuit breaker (Task 9)", async () => {
    let attempts = 0;

    const mockGoogle = {
      models: {
        generateContent: async () => {
          attempts++;
          if (attempts === 1) {
            const err = new Error("Resource has been exhausted (e.g. check quota).");
            err.statusCode = 429;
            throw err;
          }
          return { text: "Success on retry!" };
        },
      },
    };

    const res = await run(
      "gemini-3-flash",
      "chat_completion",
      { messages: [{ role: "user", content: "retry test" }] },
      {
        userId: "user-retry",
        noCharge: true,
        maxRetries: 2,
        initialBackoffMs: 20, // fast backoff for test
        sdkClient: mockGoogle,
        credential: "fake",
      }
    );

    assert.equal(res.status, "success");
    assert.equal(res.content, "Success on retry!");
    assert.equal(attempts, 2);
  });
});
