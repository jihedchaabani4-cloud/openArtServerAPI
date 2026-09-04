import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../../index.js";
import { generationRepository } from "../../../repositories/generationRepository.js";
import { walletService } from "../../../services/walletService.js";
import { getRegistry } from "../../registry/loader.js";

test("Immutable Execution Snapshots & Schema Versioning", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.WAVESPEED_API_KEY = "test_key";
  const mockCp = { async getCredential() { return null; } };

  const testUser = "user_snapshot_test_123";
  await walletService.setBalance(testUser, 100);

  let genResult;
  let generationId;

  await t.test("Executes generation and records snapshot with exact versions and sanitized inputs", async () => {
    genResult = await run(
      "nanobana_pro",
      "text_to_image",
      {
        prompt: "A neon city in rain",
        resolution: "2k",
        aspect_ratio: "16:9",
        quality: "hd",
      },
      {
        userId: testUser,
        credentialProvider: mockCp,
      }
    );

    assert.ok(genResult.url, "Should return generated output URL");
    generationId = genResult.metadata.generationId;
    assert.ok(generationId, "Should generate a generationId");

    // Fetch snapshot from repository
    const snapshot = await generationRepository.getSnapshot(generationId);
    assert.ok(snapshot, "Snapshot must exist in repository");

    assert.equal(snapshot.generationId, generationId);
    assert.equal(snapshot.userId, testUser);
    assert.equal(snapshot.model, "nanobana_pro");
    assert.equal(snapshot.operation, "text_to_image");
    assert.equal(snapshot.schema_version, "2026-09-v1");
    assert.equal(snapshot.pricing_version, "2026-09-v1");
    assert.equal(snapshot.status, "success");
    assert.equal(snapshot.provider_used, "wavespeed");
    assert.ok(snapshot.credits_charged > 0, "Should record non-zero credits charged");
    assert.equal(snapshot.inputs_snapshot.resolution, "2k");
    assert.equal(snapshot.inputs_snapshot.quality, "hd");
  });

  await t.test("Historic snapshot remains immutable after subsequent pricing rule mutations", async () => {
    const historicalSnapshot = await generationRepository.getSnapshot(generationId);
    const originalChargedCredits = historicalSnapshot.credits_charged;
    const originalPricingVersion = historicalSnapshot.pricing_version;

    // Simulate an operator modifying the pricing rule in the registry
    const { pricingRules } = getRegistry();
    const ruleKey = "nanobana_pro.text_to_image";
    const originalRule = pricingRules.get(ruleKey);

    try {
      // Modify base_price to 100 credits and bump pricing_version
      pricingRules.set(ruleKey, {
        ...originalRule,
        base_price: 100,
        pricing_version: "2026-10-v2",
      });

      // Retrieve previous snapshot again
      const queriedSnapshot = await generationRepository.getSnapshot(generationId);

      // Verify that historic snapshot still has original rate, version, and charge
      assert.equal(queriedSnapshot.credits_charged, originalChargedCredits, "Historic creditsCharged must not drift");
      assert.equal(queriedSnapshot.pricing_version, originalPricingVersion, "Historic pricing_version must not drift");
      assert.notEqual(queriedSnapshot.pricing_version, "2026-10-v2", "Must not adopt new pricing version");
      assert.equal(queriedSnapshot.schema_version, "2026-09-v1", "Historic schema_version must remain intact");
    } finally {
      // Restore original rule
      pricingRules.set(ruleKey, originalRule);
    }
  });

  await t.test("Records failed snapshot when provider fails and credits are released", async () => {
    const failingUser = "user_snapshot_failing_456";
    await walletService.setBalance(failingUser, 50);

    const failingGenId = `gen_fail_${Date.now()}`;
    const failingCp = {
      async getCredential() {
        throw new Error("Simulated credential error");
      },
    };

    await assert.rejects(
      async () => {
        await run(
          "nanobana_pro",
          "text_to_image",
          {
            prompt: "__SIMULATE_FAILURE__",
            resolution: "1k",
          },
          {
            userId: failingUser,
            generationId: failingGenId,
            credentialProvider: mockCp,
          }
        );
      },
      (err) => err.message.includes("Simulated WaveSpeed provider outage")
    );

    // Verify failed snapshot was recorded
    const failSnapshot = await generationRepository.getSnapshot(failingGenId);
    assert.ok(failSnapshot, "Failed generation must record an audit snapshot");
    assert.equal(failSnapshot.status, "failed");
    assert.equal(failSnapshot.credits_charged, 0, "No credits charged on failure");
    assert.ok(failSnapshot.error_message.includes("Simulated WaveSpeed provider outage"));

    // Verify user balance restored in full
    const finalBalance = await walletService.getBalance(failingUser);
    assert.equal(finalBalance, 50, "User balance must remain 50 after failure");
  });
});
