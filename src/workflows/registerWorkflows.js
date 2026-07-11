import { registerWorkflows } from "./workflowRegistry.js";
import { firstSliceImageWorkflow } from "./definitions/firstSliceImageWorkflow.js";
import { firstSliceVideoWorkflow } from "./definitions/firstSliceVideoWorkflow.js";

export const firstSliceWorkflows = [firstSliceImageWorkflow, firstSliceVideoWorkflow];

export function registerFirstSliceWorkflows(options = { replace: true }) {
  return registerWorkflows(firstSliceWorkflows, options);
}

registerFirstSliceWorkflows({ replace: true });
