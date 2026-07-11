/** @typedef {{ rule: string, message: string, details?: Record<string, unknown> }} BindingIssue */

const INPUT_BINDING = /^\$\{input\.([a-zA-Z_][a-zA-Z0-9_]*)\}$/;
const NODE_OUTPUT_BINDING = /^\$\{([a-zA-Z_][a-zA-Z0-9_-]*)\.output\.([a-zA-Z_][a-zA-Z0-9_.]+)\}$/;

/**
 * @param {string} value
 */
export function isBindingExpression(value) {
  return typeof value === "string" && value.startsWith("${") && value.endsWith("}");
}

/**
 * @param {string} binding
 * @returns {{ kind: 'input', field: string } | { kind: 'node_output', nodeId: string, path: string } | null}
 */
export function parseBinding(binding) {
  if (typeof binding !== "string") return null;
  const inputMatch = binding.match(INPUT_BINDING);
  if (inputMatch) {
    return { kind: "input", field: inputMatch[1] };
  }
  const nodeMatch = binding.match(NODE_OUTPUT_BINDING);
  if (nodeMatch) {
    return { kind: "node_output", nodeId: nodeMatch[1], path: nodeMatch[2] };
  }
  return null;
}

/**
 * @param {import('../contracts/workflow.js').WorkflowDefinition} workflow
 * @param {Record<string, import('../contracts/node.js').NodeRegistryEntry>} nodes
 * @returns {BindingIssue[]}
 */
export function validateBindings(workflow, nodes) {
  /** @type {BindingIssue[]} */
  const issues = [];
  const nodeIds = Object.keys(workflow.nodes);

  for (const [field, prop] of Object.entries(workflow.input_schema?.properties || {})) {
    if (field === "character") {
      issues.push({
        rule: "UNKNOWN_INPUT_FIELD",
        message: 'Singular "character" is not allowed; use "characters" (array).',
        details: { field },
      });
    }
    void prop;
  }

  for (const [nodeId, nodeConfig] of Object.entries(workflow.nodes)) {
    const nodeType = nodes[nodeConfig.type];
    if (!nodeType) continue;

    const bindingGroups = [
      ["user_inputs", nodeConfig.user_inputs || {}],
      ["inputs", nodeConfig.inputs || {}],
    ];

    for (const [source, bindings] of bindingGroups) {
      for (const [key, binding] of Object.entries(bindings)) {
        if (key === "character") {
          issues.push({
            rule: "UNKNOWN_INPUT_FIELD",
            message: `Node "${nodeId}" uses forbidden singular field "character"; use "characters".`,
            details: { nodeId, source, key },
          });
        }

        if (!isBindingExpression(binding)) {
          issues.push({
            rule: "INVALID_BINDING",
            message: `Node "${nodeId}" ${source}.${key} must be a binding expression.`,
            details: { nodeId, source, key, binding },
          });
          continue;
        }

        const parsed = parseBinding(binding);
        if (!parsed) {
          issues.push({
            rule: "INVALID_BINDING",
            message: `Node "${nodeId}" has malformed binding: ${binding}`,
            details: { nodeId, source, key, binding },
          });
          continue;
        }

        if (parsed.kind === "input") {
          if (!workflow.input_schema.properties?.[parsed.field]) {
            issues.push({
              rule: "UNKNOWN_INPUT_FIELD",
              message: `Binding ${binding} references unknown input field "${parsed.field}".`,
              details: { nodeId, binding },
            });
          }
          continue;
        }

        if (!nodeIds.includes(parsed.nodeId)) {
          issues.push({
            rule: "UNKNOWN_NODE_REFERENCE",
            message: `Binding ${binding} references unknown node "${parsed.nodeId}".`,
            details: { nodeId, binding },
          });
          continue;
        }

        const deps = nodeConfig.depends_on || [];
        if (!deps.includes(parsed.nodeId)) {
          issues.push({
            rule: "MISSING_DEPENDENCY",
            message: `Node "${nodeId}" must depend_on "${parsed.nodeId}" to use ${binding}.`,
            details: { nodeId, binding, depends_on: deps },
          });
        }

        const upstreamType = nodes[workflow.nodes[parsed.nodeId].type];
        const rootField = parsed.path.split(".")[0];
        if (!upstreamType?.outputs?.[rootField]) {
          issues.push({
            rule: "UNKNOWN_OUTPUT_FIELD",
            message: `Binding ${binding} references unknown output "${rootField}" on node type "${workflow.nodes[parsed.nodeId].type}".`,
            details: { nodeId, binding },
          });
        }
      }
    }

    for (const outputBinding of Object.values(workflow.outputs || {})) {
      if (typeof outputBinding !== "string") continue;
      const parsed = parseBinding(outputBinding);
      if (!parsed || (parsed.kind !== "node_output" && parsed.kind !== "input")) {
        issues.push({
          rule: "INVALID_OUTPUT_BINDING",
          message: `Workflow output binding must reference a node output or input: ${outputBinding}`,
          details: { outputBinding },
        });
      }
    }
  }

  return issues;
}

export { INPUT_BINDING, NODE_OUTPUT_BINDING };
