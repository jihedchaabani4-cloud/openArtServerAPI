/**
 * Backward-compatible pure helper exports.
 *
 * Write-side workflow/media creation moved to `src/services/WorkflowCreationService.js`.
 * New pure builder imports should target `src/utils/workflowBuilders.js`.
 */
export {
  buildGenerationConfig,
  buildDisplayName,
  inferStepId,
  getAspectRatio,
} from "./workflowBuilders.js";
