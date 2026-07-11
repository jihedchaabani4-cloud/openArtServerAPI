import { enqueueTreatmentJob } from "../../queue/treatmentJob.js";

export class WorkflowQueueGateway {
  async enqueueWorkflowJob(type, payload, options = {}) {
    return enqueueTreatmentJob(type, payload, options);
  }
}
