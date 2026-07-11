import { registerFeatures, firstSliceFeatureEntries } from "./featureRegistry.js";

export function registerFirstSliceFeatures(options = { replace: true }) {
  return registerFeatures(firstSliceFeatureEntries, options);
}

export { firstSliceFeatureEntries };
