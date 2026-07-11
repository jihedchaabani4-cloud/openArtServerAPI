import { loadRegistries } from "../../src/v2/registry/registryLoader.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runRegistryLoadCheck() {
  const registries = loadRegistries();
  assert(Object.keys(registries.nodes).length === 4, "Expected 4 node types.");
  assert(registries.processors.enhancePrompt?.network === true, "enhancePrompt must be network: true.");
  assert(registries.skills["character-sheet"], "character-sheet skill must load.");
  assert(registries.skills.storyboard, "storyboard skill must load.");
  assert(registries.skills["movie-poster"], "movie-poster skill must load.");
  assert(registries.workflows["character-sheet-v1"], "character-sheet-v1 workflow must load.");
  console.log("[v2:checkRegistryLoad] PASS");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  runRegistryLoadCheck();
}
