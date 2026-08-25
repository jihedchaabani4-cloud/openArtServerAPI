import { getUseCase } from "./useCaseRegistry.js";
import { compileWorkflowById } from "../v2/compiler/compileWorkflow.js";
import { createBillingStrategy } from "../v2/billing/billingStrategy.js";
import { startWorkflowRun } from "../v2/runner/workflowRunner.js";
import { loadRegistries } from "../v2/registry/registryLoader.js";

let cachedRegistries = null;
export function clearRegistryCache() {
  cachedRegistries = null;
}
export function getRegistries() {
  if (process.env.NODE_ENV !== "production") {
    return loadRegistries();
  }
  if (!cachedRegistries) {
    cachedRegistries = loadRegistries();
  }
  return cachedRegistries;
}

/**
 * Validates dynamic run input payload against Use Case input schema.
 */
export function validateInputs(input = {}, schema = {}) {
  for (const [key, fieldConfig] of Object.entries(schema)) {
    let val = input[key];

    // Check required fields
    if (fieldConfig.required && (val === undefined || val === null || val === "")) {
      const err = new Error(`Missing required field: "${key}"`);
      err.statusCode = 400;
      throw err;
    }

    if (val !== undefined && val !== null && val !== "") {
      // Type validation
      if (fieldConfig.type === "number" && isNaN(Number(val))) {
        const err = new Error(`Field "${key}" must be a number`);
        err.statusCode = 400;
        throw err;
      }

      if (fieldConfig.type === "enum" && Array.isArray(fieldConfig.options)) {
        if (!fieldConfig.options.includes(val)) {
          const err = new Error(`Field "${key}" must be one of: ${fieldConfig.options.join(", ")}`);
          err.statusCode = 400;
          throw err;
        }
      }
    }
  }
}

/**
 * Validates inputs, compiles workflow plan, estimates cost, and prechecks user balance.
 */
export async function precheckUseCaseCredits({
  useCaseId,
  input = {},
  userId,
  walletService = null,
  pricingService = null,
  registries = null,
}) {
  const useCase = getUseCase(useCaseId);
  if (!useCase) {
    const err = new Error(`Use Case "${useCaseId}" not found`);
    err.statusCode = 404;
    err.code = "USE_CASE_NOT_FOUND";
    throw err;
  }

  validateInputs(input, useCase.inputSchema);

  const finalRegistries = registries || getRegistries();
  const plan = compileWorkflowById(useCase.workflowRef, finalRegistries);

  const strategyName = useCase.billing?.strategy || "free";
  const billingStrategy = createBillingStrategy(strategyName);
  const totalCost = await billingStrategy.estimateTotal(plan, input, pricingService);

  await billingStrategy.preCheck(userId, totalCost, walletService);
  return { totalCost, plan };
}

/**
 * Orchestrates Use Case execution lifecycle.
 * @param {Object} options
 * @param {string} options.useCaseId
 * @param {Object} options.input
 * @param {string} options.userId
 * @param {Object} [options.walletService]
 * @param {Object} [options.pricingService]
 * @param {Object} [options.workflowRunner]
 * @param {Object} [options.registries]
 */
export async function run({
  useCaseId,
  input = {},
  userId,
  walletService = null,
  pricingService = null,
  workflowRunner = null,
  registries = null,
}) {
  console.log(`\n================================================================`);
  console.log(`🚀 [UseCaseRunner] Starting Use Case Execution`);
  console.log(`   Use Case ID : ${useCaseId}`);
  console.log(`   User ID     : ${userId || "anonymous"}`);
  console.log(`================================================================`);

  // 1. Resolve Use Case
  const useCase = getUseCase(useCaseId);
  if (!useCase) {
    console.error(`❌ [UseCaseRunner] Error: Use Case "${useCaseId}" not found`);
    const err = new Error(`Use Case "${useCaseId}" not found`);
    err.statusCode = 404;
    err.code = "USE_CASE_NOT_FOUND";
    throw err;
  }

  // 2. Validate input parameters against inputSchema
  validateInputs(input, useCase.inputSchema);
  console.log(`📥 [UseCaseRunner] Stage 1: Input validation passed against schema.`);

  // Map source_url to source_asset object for compatibility with V2 compiler and workflows
  if (input.source_url && !input.source_asset) {
    input.source_asset = {
      url: input.source_url,
      type: "image",
    };
  }

  // 3. Automatically resolve registries if omitted
  const finalRegistries = registries || getRegistries();

  // 4. Compile V2 workflow associated with the Use Case
  if (!finalRegistries || !finalRegistries.workflows[useCase.workflowRef]) {
    console.error(`❌ [UseCaseRunner] Error: Associated workflow "${useCase.workflowRef}" not found in registries`);
    const err = new Error(`Associated workflow "${useCase.workflowRef}" not found in registries`);
    err.statusCode = 404;
    err.code = "WORKFLOW_NOT_FOUND";
    throw err;
  }

  let plan;
  try {
    plan = compileWorkflowById(useCase.workflowRef, finalRegistries);
    console.log(`⚙️ [UseCaseRunner] Stage 2: Workflow compiled successfully (${useCase.workflowRef})`);
  } catch (compilationErr) {
    console.error(`❌ [UseCaseRunner] Error compiling workflow "${useCase.workflowRef}":`, compilationErr.message);
    const err = new Error(`Workflow compilation failed: ${compilationErr.message}`);
    err.statusCode = 422;
    err.code = "COMPILATION_FAILED";
    err.errors = compilationErr.errors || [];
    throw err;
  }

  // 5. Select billing strategy
  const strategyName = useCase.billing?.strategy || "free";
  const billingStrategy = createBillingStrategy(strategyName);

  // 6. Estimate total workflow credit cost
  const totalCost = await billingStrategy.estimateTotal(plan, input, pricingService);
  console.log(`💳 [UseCaseRunner] Stage 3: Billing Strategy (${strategyName}) — Estimated Cost: ${totalCost} credit(s)`);

  // 7. Precheck user credit balance
  try {
    await billingStrategy.preCheck(userId, totalCost, walletService);
    console.log(`✅ [UseCaseRunner] Stage 4: User balance verified.`);
  } catch (billingErr) {
    console.error(`❌ [UseCaseRunner] Billing precheck failed:`, billingErr.message);
    const err = new Error(billingErr.message);
    err.statusCode = 402;
    err.code = billingErr.code || "INSUFFICIENT_CREDITS";
    err.required = billingErr.required ?? totalCost;
    err.available = billingErr.available ?? 0;
    throw err;
  }

  // 8. Execute workflow plan
  const startWorkflowRunFn = workflowRunner?.startWorkflowRun || workflowRunner || startWorkflowRun;
  if (!startWorkflowRunFn) {
    throw new Error("[UseCaseRunner] workflowRunner dependency is missing");
  }

  const runtimeInput = {
    ...input,
    userId,
  };

  console.log(`🚀 [UseCaseRunner] Stage 5: Dispatching workflow run to V2 Engine...`);
  const runResult = await startWorkflowRunFn(plan, runtimeInput);

  console.log(`🎉 [UseCaseRunner] Execution Started! Run ID: ${runResult.run_id} (Status: ${runResult.status})`);
  console.log(`================================================================\n`);

  return {
    executionId: runResult.run_id,
    status: runResult.status,
    totalCost,
  };
}
