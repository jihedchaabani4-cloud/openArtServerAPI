export class WorkflowStatusService {
  constructor({ executionRepository }) {
    this.executionRepository = executionRepository;
  }

  async getStatus(executionId) {
    const execution = await this.executionRepository.findById(executionId);
    if (!execution) {
      return {
        error: {
          errorCode: "WORKFLOW_NOT_FOUND",
          message: "Workflow execution was not found.",
        },
      };
    }

    return {
      executionId: execution.executionId,
      workflowId: execution.workflowId,
      status: execution.status,
      jobReference: execution.jobReference,
      mediaAssets: execution.mediaAssets || [],
      error: execution.error || null,
      traceId: execution.traceId || null,
    };
  }
}
