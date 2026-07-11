import { workflowRunner } from "../container.js";
import { normalizeWorkflowRunInput, normalizeWorkflowRunResult } from "./workflowRunContract.js";

export class InternalWorkflowClient {
  constructor({ runner = workflowRunner } = {}) {
    this.runner = runner;
  }

  async run(input) {
    const normalized = normalizeWorkflowRunInput({
      ...input,
      caller: {
        type: "internal",
        ...(input.caller || {}),
      },
    });
    const result = await this.runner.run(normalized);
    return normalizeWorkflowRunResult(result);
  }
}

export const internalWorkflowClient = new InternalWorkflowClient();
