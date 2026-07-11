import { MEDIA_CAPABILITIES, WORKFLOW_STEP_TYPES } from "../workflowConstants.js";

export const firstSliceVideoWorkflow = {
  workflowId: "first-slice-video-generation",
  version: "0.1.0",
  inputSchemaId: "first-slice-video-generation.input",
  resultSchemaId: "first-slice-video-generation.result",
  steps: [
    {
      type: WORKFLOW_STEP_TYPES.PROCESSING_STEP,
      stepId: "VideoTreatment",
      options: { legacyTreatment: true },
    },
    {
      type: WORKFLOW_STEP_TYPES.CAPABILITY,
      capabilityId: MEDIA_CAPABILITIES.VIDEO_GENERATION,
      providerPolicy: { provider: "auto", allowFailover: true, costPreference: "balanced", latencyPreference: "balanced" },
    },
  ],
  lifecyclePolicy: {
    asyncRequiredAfterSeconds: 5,
    retryableFailureCodes: ["PROVIDER_TIMEOUT", "QUEUE_UNAVAILABLE"],
    terminalFailureCodes: ["INVALID_FEATURE", "INVALID_MODE", "INSUFFICIENT_FUNDS"],
  },
};
