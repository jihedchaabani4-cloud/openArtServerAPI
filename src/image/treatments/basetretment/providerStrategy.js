import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";

export function resolveProvider({ model_name, input_assets = [], models = {} }) {
  const route = getImageModel(model_name);
  const modelGroup = route?.group || models[model_name];

  if (!modelGroup && !route) {
    throw new Error(`Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`);
  }

  const hasRefs = (input_assets?.length ?? 0) > 0;
  const isMulti = (input_assets?.length ?? 0) > 1;
  const variantKey = hasRefs ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

  const provider =
    route?.[variantKey] ||
    (hasRefs && route?.i2i) ||
    route?.t2i ||
    modelGroup?.[variantKey] ||
    modelGroup?.i2i ||
    modelGroup?.t2i ||
    modelGroup;

  if (!provider) {
    throw new Error(`Provider not found for model "${model_name}"`);
  }

  if (!["t2i", "i2i"].includes(provider.type)) {
    throw new Error(`Model "${model_name}" is not an image model`);
  }

  return provider;
}

export function buildProviderPayload(provider, form) {
  if (typeof provider.buildPayload === "function") {
    return provider.buildPayload(form);
  }

  if (typeof provider.adapt === "function") {
    const adapted = provider.adapt(form);
    return typeof provider.toPayload === "function"
      ? provider.toPayload(adapted)
      : adapted;
  }

  return form;
}

export function extractOutputUrl(result = {}) {
  return (
    result.image_url ||
    result.url ||
    result.outputUrl ||
    result.output?.url ||
    (Array.isArray(result.output) ? result.output[0] : null)
  );
}
