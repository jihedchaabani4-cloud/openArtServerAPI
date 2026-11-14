/**
 * @owns System 1: Generation & Workflows — Canonical entry point for all business UseCase operations and execution.
 *
 * Re-exports from #generation/tools.
 * Rollback failure handling in canonical implementation:
 * rollbackUseCase(jobData).catch((rollbackErr) => { useCaseLogger.error(rollbackErr); })
 */
export { UseCaseService } from "#generation/tools";
