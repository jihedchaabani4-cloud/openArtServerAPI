import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UseCaseBillingRuntime, buildCompactCostBreakdown } from "../../src/v2/runtime/useCaseBillingRuntime.js";
import { WalletService } from "../../src/platform/billing/WalletService.js";

describe("D2.3 — Compact Billing Metadata & UTF-8 Byte Validation Boundary Tests", () => {
  it("TEST 1: buildCompactCostBreakdown extracts only totalCredits and node credits, stripping all heavy inputs", () => {
    const heavyPlan = {
      mode: "upfront-reserve",
      totalCredits: 45,
      billableNodes: [
        {
          nodeId: "node_heavy_1",
          nodeType: "video-generation",
          input: {
            prompt: "A cinematic film of a futuristic city ".repeat(200), // ~8KB prompt
            parameters: {
              input_image: "data:image/png;base64," + "A".repeat(10000), // 10KB base64
              resolution: "1080p",
              duration: 5,
            },
            references: ["ref_1", "ref_2", "ref_3"],
          },
          cost: {
            totalCredits: 45,
            amount: "45",
            currency: "credits",
            pricingMode: "default",
          },
        },
      ],
    };

    assert.equal(typeof buildCompactCostBreakdown, "function", "buildCompactCostBreakdown must be exported");

    const compact = buildCompactCostBreakdown(heavyPlan);
    assert.deepEqual(compact, {
      totalCredits: 45,
      nodes: [
        {
          nodeId: "node_heavy_1",
          nodeType: "video-generation",
          credits: 45,
        },
      ],
    });

    const json = JSON.stringify(compact);
    assert.ok(json.length < 300, `Compact breakdown must be small (< 300 bytes), got ${json.length}`);
    assert.ok(!json.includes("base64"), "Compact breakdown must not leak base64 data");
    assert.ok(!json.includes("futuristic city"), "Compact breakdown must not leak prompt text");
  });

  it("TEST 2: reserveUseCase with a 20KB billingPlan successfully reserves without throwing 'Metadata too large'", async () => {
    let capturedMetadata = null;
    const mockWallet = {
      reserve: async ({ userId, amount, referenceId, metadata }) => {
        capturedMetadata = metadata;
        // Run real WalletService metadata validator logic
        const json = JSON.stringify(metadata);
        const bytes = Buffer.byteLength(json, "utf8");
        if (bytes > 4096) {
          const err = new Error(`Metadata too large (max 4096 bytes)`);
          err.code = "INVALID_METADATA";
          throw err;
        }
        return {
          id: "tx-test-123",
          reference_id: referenceId,
          amount,
          status: "HELD",
        };
      },
    };

    const runtime = new UseCaseBillingRuntime({ walletService: mockWallet });

    const heavyBillingPlan = {
      mode: "upfront-reserve",
      totalCredits: 30,
      billableNodes: [
        {
          nodeId: "gen_video_node",
          nodeType: "video-generation",
          input: {
            prompt: "Massive prompt ".repeat(500),
            parameters: {
              input_image: "data:image/jpeg;base64," + "B".repeat(20000), // 20KB
            },
          },
          cost: { totalCredits: 30, amount: "30" },
        },
      ],
    };

    const result = await runtime.reserveUseCase({
      userId: "user-test-d23",
      useCaseId: "video-generation-v1",
      workflowRunId: "run-d23-test",
      workflowId: "wf-d23-test",
      totalCredits: 30,
      costBreakdown: heavyBillingPlan,
    });

    assert.equal(result.billingStatus, "reserved");
    assert.ok(capturedMetadata, "Metadata must be passed to wallet.reserve");
    const jsonStr = JSON.stringify(capturedMetadata);
    const byteLength = Buffer.byteLength(jsonStr, "utf8");
    assert.ok(
      byteLength < 500,
      `Captured metadata size must be strictly compact (< 500 bytes), got ${byteLength} bytes`
    );
    assert.ok(!jsonStr.includes("data:image"), "Metadata must not contain image data URIs");
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
