import {
  calculateCost as defaultCalculateCost,
  resolveOperation,
} from "../models/index.js";

const BILLABLE_NODE_TYPES = new Set([
  "image-generation",
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

function determineDomain(node) {
  if (node.type === "llm") return "text";
  return "image";
}

function operationForNode(node, inputs = {}) {
  const domain = determineDomain(node, inputs);
  return resolveOperation(inputs, domain);
}

function inputForNode(node, inputs = {}) {
  const operation = operationForNode(node, inputs);
  const nodeModel = resolveField(node, "model", inputs);
  const resolvedModel = nodeModel || inputs.model;

  const isLLMNode = node.type === "llm";
  const rawPrompt = inputs.prompt ?? resolveField(node, "prompt", inputs) ?? resolveField(node, "userPrompt", inputs);
  const messages = isLLMNode
    ? (inputs.messages || (rawPrompt ? [{ role: "user", content: rawPrompt }] : undefined))
    : inputs.messages;

  const rawQuality = inputs.quality ?? resolveField(node, "quality", inputs);
  const rawResolution = inputs.resolution ?? resolveField(node, "resolution", inputs);
  const rawCount = inputs.count ?? resolveField(node, "count", inputs);
  const rawImageUrl = inputs.image_url ?? inputs.source_url ?? inputs.image ?? resolveField(node, "image_url", inputs) ?? resolveField(node, "image", inputs);

  const nodeInput = {
    ...inputs,
    operation,
    model: resolvedModel,
    modelKey: resolvedModel,
  };

  if (messages !== undefined) nodeInput.messages = messages;
  if (rawPrompt !== undefined) nodeInput.prompt = rawPrompt;
  if (rawQuality !== undefined) nodeInput.quality = rawQuality;
  if (rawResolution !== undefined) nodeInput.resolution = rawResolution;
  if (rawCount !== undefined) nodeInput.count = Number(rawCount);
  if (rawImageUrl !== undefined) nodeInput.image_url = rawImageUrl;

  return nodeInput;
}

export function getBillableNodes(plan, inputs = {}) {
  if (!plan || !Array.isArray(plan.nodes)) return [];
  return plan.nodes
    .filter((node) => BILLABLE_NODE_TYPES.has(node.type))
    .map((node) => ({
      nodeId: node.id,
      nodeType: node.type,
      operation: operationForNode(node, inputs),
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

    const costResult = typeof calculateCostFn === "function"
      ? calculateCostFn(modelKey, billable.operation, billable.input)
      : calculateCostFn?.calculateCost?.({
          modelKey,
          operation: billable.operation,
          input: billable.input,
        });

    const rawCost = typeof costResult === "object" && costResult !== null
      ? (costResult.amount ?? costResult.totalCredits ?? 0)
      : costResult;
    const credits = Math.max(0, Math.ceil(Number(rawCost) || 0));
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
