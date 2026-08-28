import assert from "node:assert/strict";
import { getUseCase, listUseCases } from "../src/use-cases/useCaseRegistry.js";
import { registerAllUseCases } from "../src/use-cases/registerUseCases.js";
import { compileWorkflowById } from "../src/v2/compiler/compileWorkflow.js";
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { calculateWorkflowBillingPlan } from "../src/use-cases/workflowBillingPlan.js";
import { calculateCost } from "../src/models/index.js";
import { UseCaseService } from "../src/services/useCaseService.js";

console.log("\n=======================================================");
console.log("       USE CASE BILLING & CALCULATION TEST SUITE       ");
console.log("=======================================================\n");

registerAllUseCases();
const registries = loadRegistries();

// ── Test 1: image-generation-v1 with nanobana across all qualities ──
console.log("🧪 [Test 1] Testing 'image-generation-v1' with 'nanobana' across qualities:");

const qualities = [
  { quality: "standard", expectedCredits: 8 },
  { quality: "hd",       expectedCredits: 11 },
  { quality: "2k",       expectedCredits: 16 },
  { quality: "4k",       expectedCredits: 26 },
];

for (const { quality, expectedCredits } of qualities) {
  const useCase = getUseCase("image-generation-v1");
  const input = {
    model: "nanobana",
    prompt: "A beautiful cinematic cyberpunk city",
    aspect_ratio: "16:9",
    quality,
  };

  const workflow = compileWorkflowById(useCase.workflowRef, registries, {
    useCaseConfig: useCase.config,
    input,
  });

  const billingPlan = await calculateWorkflowBillingPlan({
    plan: workflow,
    inputs: input,
  });

  console.log(`   Quality: ${quality.padEnd(8)} ➔ Calculated: ${billingPlan.totalCredits} credits (Expected: ${expectedCredits})`);
  assert.equal(
    billingPlan.totalCredits,
    expectedCredits,
    `image-generation-v1 with quality=${quality} should cost ${expectedCredits} credits`
  );
}
console.log("   ✅ All image-generation-v1 qualities passed with exact decimal match!\n");

// ── Test 2: image-edit-v1 with nanobana ──
console.log("🧪 [Test 2] Testing 'image-edit-v1' with 'nanobana':");
{
  const useCase = getUseCase("image-edit-v1");
  const input = {
    model: "nanobana",
    prompt: "Add neon sunglasses to the character",
    image_url: "https://cdn.openart.ai/character.png",
    quality: "standard",
  };

  const workflow = compileWorkflowById(useCase.workflowRef, registries, {
    useCaseConfig: useCase.config,
    input,
  });

  const billingPlan = await calculateWorkflowBillingPlan({
    plan: workflow,
    inputs: input,
  });

  console.log(`   Operation: edit (standard) ➔ Calculated: ${billingPlan.totalCredits} credits (Expected: 9)`);
  assert.equal(billingPlan.totalCredits, 9, "image-edit-v1 should cost 9 credits");
  console.log("   ✅ image-edit-v1 passed!\n");
}

// ── Test 3: video-generation-v1 with kling-v3 across durations and resolutions ──
console.log("🧪 [Test 3] Testing 'video-generation-v1' with 'kling-v3' matrix:");
const videoScenarios = [
  { resolution: "720p",  durationSeconds: "5",  expectedCredits: 20 },
  { resolution: "720p",  durationSeconds: "10", expectedCredits: 40 },
  { resolution: "1080p", durationSeconds: "5",  expectedCredits: 35 },
  { resolution: "1080p", durationSeconds: "10", expectedCredits: 70 },
];

for (const { resolution, durationSeconds, expectedCredits } of videoScenarios) {
  const useCase = getUseCase("video-generation-v1");
  const input = {
    model: "kling-v3",
    prompt: "Drone shot moving through a magical forest at sunrise",
    resolution,
    durationSeconds,
  };

  const workflow = compileWorkflowById(useCase.workflowRef, registries, {
    useCaseConfig: useCase.config,
    input,
  });

  const billingPlan = await calculateWorkflowBillingPlan({
    plan: workflow,
    inputs: input,
  });

  console.log(`   Resolution: ${resolution.padEnd(5)} | Duration: ${durationSeconds.padEnd(2)}s ➔ Calculated: ${billingPlan.totalCredits} credits (Expected: ${expectedCredits})`);
  assert.equal(
    billingPlan.totalCredits,
    expectedCredits,
    `video-generation-v1 with ${resolution} ${durationSeconds}s should cost ${expectedCredits} credits`
  );
}
console.log("   ✅ All video-generation-v1 matrix scenarios passed!\n");

// ── Test 4: Full End-to-End UseCaseService Simulation with Mock Wallet Hold ──
console.log("🧪 [Test 4] Testing End-to-End UseCaseService prepareAndEnqueue with Wallet Hold:");

let heldAmount = 0;
let holdUserId = null;
let holdReferenceId = null;

const mockWalletService = {
  async hold({ userId, amount, referenceId }) {
    heldAmount = amount;
    holdUserId = userId;
    holdReferenceId = referenceId;
    return {
      id: `hold_${Date.now()}`,
      userId,
      amount,
      referenceId,
      status: "held",
    };
  },
  async getBalance() {
    return { balance: 100, available: 100, held: 0 };
  }
};

const mockJobQueueService = {
  async addUseCaseJob(jobData) {
    return { id: `job_${Date.now()}`, data: jobData };
  }
};

const useCaseService = new UseCaseService({
  walletService: mockWalletService,
  jobQueueService: mockJobQueueService,
});

const executionResult = await useCaseService.prepareAndEnqueue({
  useCaseId: "image-generation-v1",
  userId: "user_vip_999",
  input: {
    model: "nanobana",
    prompt: "An astronaut exploring ancient alien ruins, cinematic 8k",
    quality: "hd", // 11 credits
    aspect_ratio: "16:9",
  },
  jobQueueService: mockJobQueueService,
});

console.log(`   Job Enqueued: ${executionResult.jobId}`);
console.log(`   Hold Created: ID=${executionResult.billingHoldId} | Amount=${heldAmount} credits | User=${holdUserId}`);
console.log(`   Billing Summary: Required=${executionResult.cost.totalCredits} credits | Reserved=${executionResult.billing.reservedCredits}`);

assert.equal(heldAmount, 11, "Wallet hold should exactly match the 11 credits calculated for nanobana HD");
assert.equal(holdUserId, "user_vip_999", "Hold should be assigned to the correct user");
assert.equal(executionResult.cost.totalCredits, 11);

console.log("   ✅ End-to-end UseCaseService + Wallet hold verified with 100% precision!\n");

console.log("=======================================================");
console.log(" 🎉 ALL USE CASE CALCULATION & PRICING TESTS PASSED! ");
console.log("=======================================================\n");
