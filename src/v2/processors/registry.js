/**
 * Processor Implementation Registry (T056)
 *
 * Maps processor names (as declared in processors.yaml) to their run()
 * implementations. This is the single lookup table used by the Processor
 * Engine inside promptBuilderNode.
 *
 * Each processor module exports:
 *   async function run(context, parameters, deps): WorkflowContext
 */

import { run as resolveCharacters } from "./resolveCharacters.js";
import { run as resolveReferences } from "./resolveReferences.js";
import { run as applyCharacterTemplate } from "./applyCharacterTemplate.js";
import { run as applyPoseTemplate } from "./applyPoseTemplate.js";
import { run as applySheetLayout } from "./applySheetLayout.js";
import { run as applyCameraStyle } from "./applyCameraStyle.js";
import { run as buildStoryboardLayout } from "./buildStoryboardLayout.js";
import { run as applyComposition } from "./applyComposition.js";
import { run as applyTypographyArea } from "./applyTypographyArea.js";
import { run as enhancePrompt } from "./enhancePrompt.js";

/** @type {Record<string, (context: object, parameters: object, deps: object) => Promise<object>>} */
export const processorRegistry = {
  resolveCharacters,
  resolveReferences,
  applyCharacterTemplate,
  applyPoseTemplate,
  applySheetLayout,
  applyCameraStyle,
  buildStoryboardLayout,
  applyComposition,
  applyTypographyArea,
  enhancePrompt,
};

/**
 * Resolve a processor by name. Throws if unknown.
 * @param {string} name
 * @returns {(context: object, parameters: object, deps: object) => Promise<object>}
 */
export function getProcessor(name) {
  const fn = processorRegistry[name];
  if (!fn) {
    throw new Error(`Unknown processor: "${name}". Check processors.yaml and registry.js.`);
  }
  return fn;
}
