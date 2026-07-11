import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { compileWorkflow, compileWorkflowById } from "../../src/v2/compiler/compileWorkflow.js";
import { resolveRetryPolicy } from "../../src/v2/compiler/resolveRetryPolicy.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectCompilationError(fn, expectedRule) {
  try {
    fn();
    throw new Error(`Expected compilation to fail with ${expectedRule}.`);
  } catch (error) {
    if (error.name === "CompilationFailed") {
      const rules = error.errors.map((e) => e.rule);
      assert(rules.includes(expectedRule), `Expected rule ${expectedRule}, got ${rules.join(", ")}`);
      return;
    }
    if (error.rule === expectedRule) return;
    throw error;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  /** @type {{ mode: "all" | "valid" | "invalid", workflow: string | null }} */
  const options = {
    mode: "all",
    workflow: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      options.mode = /** @type {"all" | "valid" | "invalid"} */ (argv[index + 1] || "all");
      index += 1;
      continue;
    }
    if (arg === "--workflow") {
      options.workflow = argv[index + 1] || null;
      index += 1;
    }
  }

  return options;
}

function runValidCompilationChecks(registries, workflowFilter = null) {
  const workflowIds = workflowFilter
    ? [workflowFilter]
    : ["character-sheet-v1", "storyboard-v1", "movie-poster-v1", "cinematic-video-v1", "simple-image-v1"];

  for (const workflowId of workflowIds) {
    const graph = compileWorkflowById(workflowId, registries);
    assert(graph.workflow_id === workflowId, `Compiled graph workflow_id mismatch for ${workflowId}.`);
    assert(Object.keys(graph.resolved_skill_versions).length >= 1, `Skill versions must be frozen for ${workflowId}.`);
    assert(graph.parallel_groups.length >= 1, `Expected at least one parallel group for ${workflowId}.`);
  }

  if (workflowFilter) {
    return;
  }

  const characterGraph = compileWorkflowById("character-sheet-v1", registries);
  assert(characterGraph.resolved_skill_versions["character-sheet"] === "1.0.0", "character-sheet version must be 1.0.0.");
  const promptNode = characterGraph.nodes.find((n) => n.id === "build_prompt");
  assert(promptNode?.retry_policy.max_attempts >= 2, "prompt-builder with enhancePrompt must elevate max_attempts.");

  const purePolicy = resolveRetryPolicy(
    { max_attempts: 1, backoff: "none" },
    true,
    [{ name: "resolveCharacters", network: false }],
  );
  assert(purePolicy.max_attempts === 1, "Non-network pipeline should keep max_attempts: 1.");
}

function runInvalidCompilationChecks(registries) {
  expectCompilationError(() => {
    compileWorkflow(
      {
        id: "bad-node-type",
        name: "Bad",
        version: "1.0.0",
        description: "x",
        metadata: { category: "x", tags: [], author: "system" },
        input_schema: { required: ["prompt"], properties: { prompt: { type: "string" } } },
        nodes: { n1: { type: "does-not-exist" } },
        outputs: {},
      },
      registries,
    );
  }, "UNKNOWN_NODE_TYPE");

  expectCompilationError(() => {
    compileWorkflow(
      {
        id: "cycle",
        name: "Cycle",
        version: "1.0.0",
        description: "x",
        metadata: { category: "x", tags: [], author: "system" },
        input_schema: { required: ["prompt"], properties: { prompt: { type: "string" } } },
        nodes: {
          a: { type: "prompt-builder", depends_on: ["b"], user_inputs: { prompt: "${input.prompt}" } },
          b: { type: "image-generation", depends_on: ["a"], inputs: { prompt: "${a.output.finalPrompt}" } },
        },
        outputs: {},
      },
      registries,
    );
  }, "CYCLIC_DEPENDENCY");

  expectCompilationError(() => {
    compileWorkflow(
      {
        id: "bad-character-field",
        name: "Bad Character Field",
        version: "1.0.0",
        description: "x",
        metadata: { category: "x", tags: [], author: "system" },
        input_schema: {
          required: ["prompt"],
          properties: { prompt: { type: "string" }, character: { type: "object" } },
        },
        nodes: {
          build_prompt: {
            type: "prompt-builder",
            user_inputs: { prompt: "${input.prompt}", character: "${input.character}" },
          },
        },
        outputs: {},
      },
      registries,
    );
  }, "UNKNOWN_INPUT_FIELD");

  expectCompilationError(() => {
    compileWorkflow(
      {
        id: "skill-on-image",
        name: "Skill On Image",
        version: "1.0.0",
        description: "x",
        metadata: { category: "x", tags: [], author: "system" },
        input_schema: { required: ["prompt"], properties: { prompt: { type: "string" } } },
        nodes: {
          generate: {
            type: "image-generation",
            config: { skills: ["character-sheet"] },
            user_inputs: { prompt: "${input.prompt}" },
          },
        },
        outputs: {},
      },
      registries,
    );
  }, "SKILL_ON_NON_SKILL_AWARE_NODE");
}

export function runCompilerCheck(options = {}) {
  const registries = loadRegistries();
  const mode = options.mode || "all";
  const workflow = options.workflow || null;

  if (mode === "all" || mode === "valid") {
    runValidCompilationChecks(registries, workflow);
  }

  if (workflow && mode === "invalid") {
    throw new Error("--workflow cannot be combined with --mode invalid.");
  }

  if (mode === "all" || mode === "invalid") {
    runInvalidCompilationChecks(registries);
  }

  console.log("[v2:checkCompiler] PASS");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  runCompilerCheck(parseArgs());
}
