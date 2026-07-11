import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompilationError, throwCompilationErrors } from "./errors.js";
import { validateBindings, isBindingExpression } from "./validateBindings.js";
import { resolveRetryPolicy } from "./resolveRetryPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {Record<string, string[]>} adjacency
 * @param {string[]} nodeIds
 * @returns {string[][]}
 */
function buildParallelGroups(adjacency, nodeIds) {
  /** @type {Map<string, number>} */
  const inDegree = new Map(nodeIds.map((id) => [id, (adjacency[id] || []).length]));

  /** @type {string[][]} */
  const groups = [];
  let queue = nodeIds.filter((id) => (inDegree.get(id) || 0) === 0);

  while (queue.length > 0) {
    groups.push([...queue]);
    /** @type {string[]} */
    const next = [];
    for (const id of queue) {
      for (const [nodeId, deps] of Object.entries(adjacency)) {
        if (deps.includes(id)) {
          inDegree.set(nodeId, (inDegree.get(nodeId) || 0) - 1);
          if (inDegree.get(nodeId) === 0) {
            next.push(nodeId);
          }
        }
      }
    }
    queue = next;
  }

  const scheduled = groups.flat();
  if (scheduled.length !== nodeIds.length) {
    throw new CompilationError("CYCLIC_DEPENDENCY", "Workflow dependency graph contains a cycle.");
  }

  return groups;
}

/**
 * @param {import('../contracts/workflow.js').WorkflowDefinition} workflow
 * @param {{
 *   nodes: Record<string, import('../contracts/node.js').NodeRegistryEntry>,
 *   skills: Record<string, import('../contracts/skill.js').SkillDefinition>,
 *   processors: Record<string, import('../contracts/processor.js').ProcessorRegistryEntry>,
 * }} registries
 * @returns {import('../contracts/executionGraph.js').ExecutionGraph}
 */
export function compileWorkflow(workflow, registries) {
  /** @type {CompilationError[]} */
  const errors = [];

  if (!workflow?.id || !workflow?.version || !workflow?.nodes || !workflow?.input_schema) {
    errors.push(new CompilationError("INVALID_SCHEMA", "Workflow missing required top-level fields."));
    throwCompilationErrors(errors);
  }

  const nodeIds = Object.keys(workflow.nodes);
  if (nodeIds.length === 0) {
    errors.push(new CompilationError("INVALID_SCHEMA", "Workflow must define at least one node."));
  }

  /** @type {Record<string, string>} */
  const resolvedSkillVersions = {};
  /** @type {Record<string, string[]>} */
  const adjacency = Object.fromEntries(nodeIds.map((id) => [id, workflow.nodes[id].depends_on || []]));

  for (const deps of Object.values(adjacency)) {
    for (const dep of deps) {
      if (!nodeIds.includes(dep)) {
        errors.push(
          new CompilationError("UNKNOWN_NODE", `depends_on references unknown node "${dep}".`, { dep }),
        );
      }
    }
  }

  for (const [nodeId, nodeConfig] of Object.entries(workflow.nodes)) {
    const nodeType = registries.nodes[nodeConfig.type];
    if (!nodeType) {
      errors.push(
        new CompilationError("UNKNOWN_NODE_TYPE", `Unknown node type "${nodeConfig.type}".`, {
          nodeId,
          type: nodeConfig.type,
        }),
      );
      continue;
    }

    const skills = nodeConfig.config?.skills;
    if (Array.isArray(skills) && skills.length > 0 && !nodeType.skill_aware) {
      errors.push(
        new CompilationError("SKILL_ON_NON_SKILL_AWARE_NODE", `Node "${nodeId}" cannot use skills.`, {
          nodeId,
        }),
      );
    }

    if (Array.isArray(skills)) {
      for (const skillId of skills) {
        const skill = registries.skills[skillId];
        if (!skill) {
          errors.push(new CompilationError("UNKNOWN_SKILL", `Unknown skill "${skillId}".`, { nodeId, skillId }));
          continue;
        }
        if (!skill.applies_to.includes(nodeConfig.type)) {
          errors.push(
            new CompilationError("SKILL_APPLIES_TO_MISMATCH", `Skill "${skillId}" cannot apply to "${nodeConfig.type}".`, {
              nodeId,
              skillId,
            }),
          );
        }
        resolvedSkillVersions[skillId] = skill.version;
        for (const processorName of skill.pipeline) {
          if (!registries.processors[processorName]) {
            errors.push(
              new CompilationError("UNKNOWN_PROCESSOR", `Skill "${skillId}" references unknown processor "${processorName}".`, {
                skillId,
                processorName,
              }),
            );
          }
        }
      }
    }
  }

  const bindingIssues = validateBindings(workflow, registries.nodes);
  for (const issue of bindingIssues) {
    errors.push(new CompilationError(issue.rule, issue.message, issue.details));
  }

  throwCompilationErrors(errors);

  const parallel_groups = buildParallelGroups(adjacency, nodeIds);

  /** @type {import('../contracts/executionGraph.js').ExecutionGraphNode[]} */
  const graphNodes = nodeIds.map((nodeId) => {
    const nodeConfig = workflow.nodes[nodeId];
    const nodeType = registries.nodes[nodeConfig.type];
    const skills = Array.isArray(nodeConfig.config?.skills) ? nodeConfig.config.skills : [];

    /** @type {{ name: string, network: boolean }[]} */
    const resolvedProcessors = [];
    for (const skillId of skills) {
      const skill = registries.skills[skillId];
      if (!skill) continue;
      for (const processorName of skill.pipeline) {
        const processor = registries.processors[processorName];
        if (processor) {
          resolvedProcessors.push({ name: processorName, network: processor.network });
        }
      }
    }

    /** @type {Record<string, unknown>} */
    const resolved_inputs = {};
    /** @type {Record<string, string>} */
    const bindings = {};

    const staticConfig = { ...(nodeConfig.config || {}) };
    delete staticConfig.skills;
    const skillParameters = staticConfig.skill_parameters || {};
    delete staticConfig.skill_parameters;
    Object.assign(resolved_inputs, staticConfig, skillParameters);

    const primarySkillId = skills[0] || null;
    if (primarySkillId) {
      const primarySkill = registries.skills[primarySkillId];
      if (primarySkill) {
        resolved_inputs.skill = {
          id: primarySkillId,
          version: primarySkill.version,
          pipeline: [...(primarySkill.pipeline || [])],
          parameter_defaults: primarySkill.parameters_schema
            ? Object.fromEntries(
                Object.entries(primarySkill.parameters_schema).map(([key, schema]) => [key, schema.default]),
              )
            : {},
          parameters: { ...skillParameters },
        };
      }
    }

    for (const [key, schema] of Object.entries(nodeType.inputs || {})) {
      if (resolved_inputs[key] === undefined && schema.default !== undefined) {
        resolved_inputs[key] = schema.default;
      }
    }

    for (const map of [nodeConfig.user_inputs || {}, nodeConfig.inputs || {}]) {
      for (const [key, binding] of Object.entries(map)) {
        if (isBindingExpression(binding)) {
          bindings[key] = binding;
        } else {
          resolved_inputs[key] = binding;
        }
      }
    }

    return {
      id: nodeId,
      type: nodeConfig.type,
      resolved_inputs,
      bindings,
      retry_policy: resolveRetryPolicy(nodeType.retry, nodeType.skill_aware, resolvedProcessors),
      ...(skills.length > 0 ? { skills, resolved_processors: resolvedProcessors } : {}),
    };
  });

  /** @type {import('../contracts/executionGraph.js').ExecutionGraphEdge[]} */
  const edges = [];
  for (const [nodeId, deps] of Object.entries(adjacency)) {
    for (const dep of deps) {
      edges.push({ from: dep, to: nodeId });
    }
  }

  return {
    workflow_id: workflow.id,
    workflow_version: workflow.version,
    nodes: graphNodes,
    edges,
    parallel_groups,
    resolved_skill_versions: resolvedSkillVersions,
    outputs: workflow.outputs || {},
  };
}

/**
 * @param {string} workflowId
 * @param {ReturnType<typeof import('../registry/registryLoader.js').loadRegistries>} registries
 */
export function compileWorkflowById(workflowId, registries) {
  const workflow = registries.workflows[workflowId];
  if (!workflow) {
    throw new CompilationError("WORKFLOW_NOT_FOUND", `Workflow "${workflowId}" not found.`);
  }
  return compileWorkflow(workflow, registries);
}

export function getDefaultRegistryRoot(registryRoot) {
  return registryRoot || path.join(__dirname, "../registry");
}
