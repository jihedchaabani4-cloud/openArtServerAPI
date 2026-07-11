import { MEDIA_CAPABILITIES, WORKFLOW_STEP_TYPES } from "../workflowConstants.js";

export const firstSliceImageWorkflow = {
  workflowId: "first-slice-image-generation",
  version: "0.1.0",
  inputSchemaId: "first-slice-image-generation.input",
  resultSchemaId: "first-slice-image-generation.result",
  steps: [
    {
      type: WORKFLOW_STEP_TYPES.PROCESSING_STEP,
      stepId: "GenerateImageTreatment",
      options: { legacyTreatment: true },
    },
    {
      type: WORKFLOW_STEP_TYPES.CAPABILITY,
      capabilityId: MEDIA_CAPABILITIES.IMAGE_GENERATION,
      providerPolicy: { provider: "auto", allowFailover: true, costPreference: "balanced", latencyPreference: "balanced" },
    },
  ],
  lifecyclePolicy: {
    asyncRequiredAfterSeconds: 5,
    retryableFailureCodes: ["PROVIDER_TIMEOUT", "QUEUE_UNAVAILABLE"],
    terminalFailureCodes: ["INVALID_FEATURE", "INVALID_MODE", "INSUFFICIENT_FUNDS"],
  },
};
