import {
  calculateCost as defaultCalculateCost,
} from "../models/index.js";

const BILLABLE_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "llm",
]);

function resolveField(node, field, inputs = {}) {
  const binding = node.bindings?.[field];
  if (typeof binding === "string") {
    const match = binding.match(/^\$\{input\.(.+)\}$/);
    if (match && inputs[match[1]] !== undefined) return inputs[match[1]];
  }
  if (node.resolved_inputs?.[field] !== undefined) return node.resolved_inputs[field];
  if (node.config?.[field] !== undefined) return node.config[field];
  return undefined;
}

/**
 * Assembles the canonical semantic input for a billable node.
 *
 * Model-specific params (resolution, quality, etc.) now live in
 * inputs.parameters (pass-through architecture). We look there first,
 * then fall back to root-level inputs for backward compatibility.
 */
function inputForNode(node, inputs = {}) {
  const nodeModel    = resolveField(node, "model", inputs);
  const resolvedModel = nodeModel || inputs.model;

  // Model-specific params live in inputs.parameters (new architecture)
  const params = (inputs.parameters && typeof inputs.parameters === "object")
    ? inputs.parameters
    : {};

  const isLLMNode  = node.type === "llm";
  const rawPrompt  = inputs.prompt
    ?? resolveField(node, "prompt",      inputs)
    ?? resolveField(node, "userPrompt",  inputs);
  const messages   = isLLMNode
    ? (inputs.messages || (rawPrompt ? [{ role: "user", content: rawPrompt }] : undefined))
    : inputs.messages;

  if (isLLMNode) {
    const llmInput = {
      model: resolvedModel,
      modelKey: resolvedModel,
    };
    if (messages !== undefined) llmInput.messages = messages;
    if (rawPrompt !== undefined) llmInput.prompt = rawPrompt;
    const sysPrompt = inputs.system_prompt ?? resolveField(node, "system_prompt", inputs);
    if (sysPrompt !== undefined) llmInput.system_prompt = sysPrompt;
    return llmInput;
  }

  // Pass-through architecture: model + caller parameters + prompt
  const nodeInput = {
    ...params,
    model:    resolvedModel,
    modelKey: resolvedModel,
  };

  if (rawPrompt !== undefined) nodeInput.prompt = rawPrompt;

  // Backward compatibility: only adopt root-level inputs if explicitly provided by caller
  if (nodeInput.quality === undefined && inputs.quality !== undefined) nodeInput.quality = inputs.quality;
  if (nodeInput.resolution === undefined && inputs.resolution !== undefined) nodeInput.resolution = inputs.resolution;
  if (nodeInput.count === undefined && inputs.count !== undefined) nodeInput.count = Number(inputs.count);
  if (nodeInput.input_image === undefined && (inputs.image_url || inputs.source_url || inputs.image)) {
    nodeInput.input_image = inputs.image_url || inputs.source_url || inputs.image;
  }

  return nodeInput;
}





export function getBillableNodes(plan, inputs = {}) {
  if (!plan || !Array.isArray(plan.nodes)) return [];
  return plan.nodes
    .filter((node) => BILLABLE_NODE_TYPES.has(node.type))
    .map((node) => ({
      nodeId: node.id,
      nodeType: node.type,
      input: inputForNode(node, inputs),
    }));
}

export async function calculateWorkflowBillingPlan({
  plan,
  inputs = {},
  calculateCostFn = defaultCalculateCost,
} = {}) {
  const billableNodes = getBillableNodes(plan, inputs);
  const breakdowns = [];
  let totalCredits = 0;

  for (const billable of billableNodes) {
    const modelKey = billable.input.modelKey || billable.input.model;
    if (!modelKey) {
      throw new Error(`[Billing] Missing required model for billable node "${billable.nodeId}" (${billable.nodeType})`);
    }

    // Model-First: pass (modelKey, semanticInput) — no explicit operation.
    // Models Management resolves configured provider and route internally from semantic params.
    const costResult = typeof calculateCostFn === "function"
      ? calculateCostFn(modelKey, billable.input)
      : calculateCostFn?.calculateCost?.({
          modelKey,
          input: billable.input,
        });

    const rawCost = typeof costResult === "object" && costResult !== null
      ? (costResult.amount ?? costResult.totalCredits)
      : costResult;

    if (typeof rawCost !== "number" || Number.isNaN(rawCost) || !Number.isFinite(rawCost) || rawCost < 0) {
      const err = new Error(`[Billing] Pricing failure for node "${billable.nodeId}" (${billable.nodeType}): cost result is invalid (${rawCost}). Pricing failure cannot default to 0.`);
      err.code = "PRICING_CONFIG_ERROR";
      err.category = "SERVER_FAULT";
      err.statusCode = 500;
      throw err;
    }

    const credits = Math.ceil(rawCost);
    totalCredits += credits;
    breakdowns.push({
      ...billable,
      cost: {
        totalCredits: credits,
        amount: String(credits),
        currency: "credits",
        pricingMode: costResult?.pricingMode || "default",
      },
    });
  }

  return {
    mode: "upfront-reserve",
    totalCredits,
    billableNodes: breakdowns,
  };
}
