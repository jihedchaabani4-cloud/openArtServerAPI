import "dotenv/config";
import { bootstrapV2 } from "../v2/bootstrap.js";
import { listUseCases, getUseCase } from "./useCaseRegistry.js";
import { listManifests } from "../v2/nodes/manifests/nodeManifestRegistry.js";
import { estimateWorkflowCost } from "../v2/billing/BudgetEstimator.js";
import { compileWorkflowById } from "../v2/compiler/compileWorkflow.js";
import { loadRegistries } from "../v2/registry/registryLoader.js";

async function runTests() {
  console.log("=== V2 Use Cases & Billing Integration Test ===\n");

  // 1. Bootstrap V2 engine
  console.log("1. Bootstrapping V2 Engine...");
  bootstrapV2();
  console.log("✓ V2 Engine bootstrapped successfully.\n");

  // 2. Verify registered Use Cases
  console.log("2. Verifying Use Case Registry...");
  const useCases = listUseCases();
  console.log(`Registered Use Cases count: ${useCases.length}`);
  for (const uc of useCases) {
    console.log(`  - [${uc.useCaseId}] ${uc.label} (Strategy: ${uc.billing.strategy})`);
  }
  if (useCases.length !== 3) {
    throw new Error(`Expected 3 use cases, got ${useCases.length}`);
  }
  console.log("✓ Use Case Registry verification passed.\n");

  // 3. Verify registered Node Manifests
  console.log("3. Verifying Node Manifests Registry...");
  const manifests = listManifests();
  console.log(`Registered Node Manifests count: ${manifests.length}`);
  for (const m of manifests) {
    console.log(`  - [${m.type}] ${m.label} (${m.badge})`);
  }
  if (manifests.length !== 4) {
    throw new Error(`Expected 4 node manifests, got ${manifests.length}`);
  }
  console.log("✓ Node Manifests verification passed.\n");

  // 4. Verify Budget Estimator & Compilation on Brand Mascot Use Case
  console.log("4. Verifying Workflow Budget Estimator...");
  const mascotUC = getUseCase("brand-mascot-ad-series");
  const registries = loadRegistries();
  const plan = compileWorkflowById(mascotUC.workflowRef, registries);
  
  console.log(`Compiled workflow graph: "${plan.workflow_id}"`);
  console.log(`  - Nodes count: ${plan.nodes.length}`);
  console.log(`  - Edges count: ${plan.edges.length}`);
  console.log("generate_mascots node details:", JSON.stringify(plan.nodes.find(n => n.id === 'generate_mascots'), null, 2));

  // Test budget estimation for count = 4 (default fallback is 12 credits for flux-pro)
  const input = { brand_name: "Nike", mascot_style: "3d", count: 4 };
  const estimatedCost = await estimateWorkflowCost(plan, input, null); // passing null pricingService to test fallback defaults
  console.log(`Estimated cost for 4 mascot images (fallback default): ${estimatedCost} credits`);
  
  // 4 images * 12 credits = 48 credits
  if (estimatedCost !== 48) {
    throw new Error(`Expected cost of 48 credits, got ${estimatedCost}`);
  }
  console.log("✓ Budget Estimator verification passed.\n");

  // 5. Verify compilation on VFX Studio Use Case (using unified image-generation node)
  console.log("5. Verifying VFX Studio Workflow compilation...");
  const vfxUC = getUseCase("vfx-studio");
  const vfxPlan = compileWorkflowById(vfxUC.workflowRef, registries);
  console.log(`Compiled VFX Studio workflow graph: "${vfxPlan.workflow_id}"`);
  console.log(`  - Nodes count: ${vfxPlan.nodes.length}`);
  console.log("✓ VFX Studio compilation passed.\n");

  console.log("==========================================");
  console.log("🎉 ALL IN-MEMORY INTEGRATION TESTS PASSED!");
  console.log("==========================================");
}

runTests().catch(err => {
  console.error("❌ Integration test failed:", err);
  process.exit(1);
});
