import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert";
import { UseCaseService } from "../../src/services/useCaseService.js";
import { UseCaseBillingRuntime } from "../../src/v2/runtime/useCaseBillingRuntime.js";
import { WorkflowBillingGateway } from "../../src/infrastructure/billing/workflowBillingGateway.js";
import { assertWalletConfiguredForEnvironment } from "../../src/container.js";
import { bootstrapV2 } from "../../src/v2/bootstrap.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { registerNodeExecutor, registry } from "../../src/v2/nodes/index.js";

bootstrapV2();

after(async () => {
  try {
    await redisConnection?.quit().catch(() => redisConnection?.disconnect());
    await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
  } catch {}
});

describe("F2.4-a — Wallet Misconfiguration & Zero Price Invariants", () => {
  let origEnv;
  let providerCallCount = 0;
  let origImageGenExecutor;

  beforeEach(() => {
    origEnv = { ...process.env };
    providerCallCount = 0;
    origImageGenExecutor = registry["image-generation"];

    registerNodeExecutor("image-generation", async () => {
      providerCallCount++;
      return {
        assets: [{ url: "https://mock-storage.example.com/asset.png", width: 1024, height: 1024 }],
      };
    });
  });

  afterEach(() => {
    process.env = origEnv;
    if (origImageGenExecutor) {
      registerNodeExecutor("image-generation", origImageGenExecutor);
    }
  });

  it("TEST 1: In production (NODE_ENV=production), server refuses to boot if wallet credentials are missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_KEY;

    assert.throws(
      () => {
        assertWalletConfiguredForEnvironment();
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Fatal: WalletService is required in production/i);
        return true;
      },
      "Must throw when booting in production with missing Supabase credentials"
    );
  });

  it("TEST 2: Missing wallet on paid usecase MUST fail with clear error and NEVER run for free (no provider call)", async () => {
    // WorkflowBillingGateway without walletService
    const unconfiguredGateway = new WorkflowBillingGateway({ walletService: null });
    const billingRuntime = new UseCaseBillingRuntime({
      walletService: null,
      billingGateway: unconfiguredGateway,
    });

    const ucService = new UseCaseService({
      walletService: null,
      billingRuntime,
      jobQueueService: {
        addUseCaseJob: async () => ({ id: "job-should-not-exist" }),
      },
    });

    // Attempt to prepare and enqueue a paid use case (image-generation-v1)
    let caughtError = null;
    try {
      await ucService.prepareAndEnqueue({
        useCaseId: "image-generation-v1",
        input: {
          prompt: "paid image prompt",
          model: "nanobana_2",
        },
        userId: "user-paid-attempt",
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, "Paid use case must fail when wallet is not configured");
    assert.strictEqual(caughtError.code, "WALLET_NOT_CONFIGURED", "Error code must indicate unconfigured wallet");
    assert.strictEqual(providerCallCount, 0, "External provider must NEVER be called when wallet is unconfigured");

    // Also assert directly on the gateway: reserving a positive amount without wallet must throw, not return NO_CHARGE
    await assert.rejects(
      async () => {
        await unconfiguredGateway.reserve({
          userId: "user-test",
          amount: 8,
          referenceId: "ref-test-unconfigured",
        });
      },
      (err) => {
        assert.strictEqual(err.code, "WALLET_NOT_CONFIGURED");
        return true;
      }
    );
  });

  it("TEST 3: NO_CHARGE is allowed ONLY for explicit finite zero (amount === 0)", async () => {
    const unconfiguredGateway = new WorkflowBillingGateway({ walletService: null });

    // Explicit finite amount 0 must return NO_CHARGE
    const zeroResult = await unconfiguredGateway.reserve({
      userId: "user-free",
      amount: 0,
      referenceId: "ref-free-explicit",
    });

    assert.strictEqual(zeroResult.kind, "NO_CHARGE", "Explicit zero amount must yield NO_CHARGE");
    assert.strictEqual(zeroResult.amount, 0);
  });

  it("TEST 4: workflowBillingGateway throws PRICING_CONFIG_ERROR for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
    const gateway = new WorkflowBillingGateway({ walletService: null });
    const invalidAmounts = [undefined, null, NaN, -1, -5, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await gateway.reserve({
            userId: "user-test",
            amount: invalidAmount,
            referenceId: `ref-invalid-${String(invalidAmount)}`,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `Amount "${invalidAmount}" must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `Expected gateway.reserve to throw PRICING_CONFIG_ERROR for amount: ${invalidAmount}`
      );
    }
  });

  it("TEST 5: useCaseBillingRuntime throws PRICING_CONFIG_ERROR for invalid totalCredits (undefined, null, NaN, -1, 'abc')", async () => {
    const runtime = new UseCaseBillingRuntime({ walletService: null });
    const invalidAmounts = [undefined, null, NaN, -1, -10, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await runtime.reserveUseCase({
            userId: "user-test",
            useCaseId: "image-generation-v1",
            totalCredits: invalidAmount,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `totalCredits "${invalidAmount}" must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `Expected reserveUseCase to throw PRICING_CONFIG_ERROR for totalCredits: ${invalidAmount}`
      );
    }
  });

  it("TEST 6: WalletService.reserve throws PRICING_CONFIG_ERROR for invalid amounts (undefined, null, NaN, -1, 'abc')", async () => {
    const { WalletService } = await import("../../src/platform/billing/WalletService.js");
    const wallet = new WalletService("https://mock.supabase.co", "mock-key");
    const invalidAmounts = [undefined, null, NaN, -1, -5, "abc", "0", {}, []];

    for (const invalidAmount of invalidAmounts) {
      await assert.rejects(
        async () => {
          await wallet.reserve({
            userId: "user-test",
            amount: invalidAmount,
            referenceId: `ref-ws-${String(invalidAmount)}`,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `WalletService.reserve amount "${invalidAmount}" must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `Expected WalletService.reserve to throw PRICING_CONFIG_ERROR for amount: ${invalidAmount}`
      );
    }
  });

  it("TEST 7: calculateWorkflowBillingPlan throws PRICING_CONFIG_ERROR if pricing calculation returns invalid cost and NEVER defaults to 0", async () => {
    const { calculateWorkflowBillingPlan } = await import("../../src/use-cases/workflowBillingPlan.js");

    const plan = {
      nodes: [
        {
          id: "generate",
          type: "image-generation",
          bindings: {
            prompt: "${input.prompt}",
            model: "${input.model}",
          },
        },
      ],
    };

    const invalidCostResults = [undefined, null, NaN, -1, "abc", "free", {}];

    for (const invalidCost of invalidCostResults) {
      await assert.rejects(
        async () => {
          await calculateWorkflowBillingPlan({
            plan,
            inputs: { prompt: "test", model: "nanobana_2" },
            calculateCostFn: () => invalidCost,
          });
        },
        (err) => {
          assert.strictEqual(err.code, "PRICING_CONFIG_ERROR", `Cost failure (${invalidCost}) must throw PRICING_CONFIG_ERROR`);
          assert.strictEqual(err.category, "SERVER_FAULT");
          return true;
        },
        `calculateWorkflowBillingPlan must never turn pricing failure (${invalidCost}) into 0`
      );
    }

    // Explicit 0 cost MUST succeed and return 0
    const zeroPlan = await calculateWorkflowBillingPlan({
      plan,
      inputs: { prompt: "test", model: "nanobana_2" },
      calculateCostFn: () => 0,
    });
    assert.strictEqual(zeroPlan.totalCredits, 0, "Explicit 0 cost must return 0 totalCredits");
  });
});
