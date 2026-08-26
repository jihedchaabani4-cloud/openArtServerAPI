import { getUseCase, listUseCases } from "./useCaseRegistry.js";
import { compileWorkflowById } from "../v2/compiler/compileWorkflow.js";
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
 * Orchestrates Use Case execution lifecycle (called from Worker).
 * Compile workflow → startWorkflowRun (DB + orchestration).
 */
export async function run({
  useCaseId,
  input = {},
  userId,
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

  // 2. Map source_url → source_asset for V2 compatibility
  if (input.source_url && !input.source_asset) {
    input.source_asset = { url: input.source_url, type: "image" };
  }

  // 3. Resolve registries
  const finalRegistries = registries || getRegistries();

  // 4. Compile V2 workflow
  if (!finalRegistries?.workflows?.[useCase.workflowRef]) {
    const err = new Error(`Associated workflow "${useCase.workflowRef}" not found in registries`);
    err.statusCode = 404;
    err.code = "WORKFLOW_NOT_FOUND";
    throw err;
  }

  let plan;
  try {
    plan = compileWorkflowById(useCase.workflowRef, finalRegistries);
    console.log(`⚙️ [UseCaseRunner] Workflow compiled: ${useCase.workflowRef}`);
  } catch (compilationErr) {
    const err = new Error(`Workflow compilation failed: ${compilationErr.message}`);
    err.statusCode = 422;
    err.code = "COMPILATION_FAILED";
    err.errors = compilationErr.errors || [];
    throw err;
  }

  // 5. Start workflow run (creates DB records + enqueues nodes)
  const runtimeInput = { ...input, userId };
  console.log(`🚀 [UseCaseRunner] Dispatching to V2 Engine...`);
  const runResult = await startWorkflowRun(plan, runtimeInput);

  console.log(`🎉 [UseCaseRunner] Run ID: ${runResult.run_id} (Status: ${runResult.status})`);
  console.log(`================================================================\n`);

  return {
    executionId: runResult.run_id,
    status: runResult.status,
  };
}
