export const runtimeFeatures = Object.freeze({
  useCasePrepareAndEnqueue: process.env.USECASE_PREPARE_AND_ENQUEUE === "true",
  upfrontUseCaseBilling: process.env.UPFRONT_USECASE_BILLING === "true",
  modelServicePricing: process.env.MODEL_SERVICE_PRICING !== "false",
  nodeEnvelopeRuntime: process.env.NODE_ENVELOPE_RUNTIME === "true",
});

export function isRuntimeFeatureEnabled(name) {
  return Boolean(runtimeFeatures[name]);
}
