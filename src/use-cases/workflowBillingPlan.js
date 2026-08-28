import { calculateCost as defaultCalculateCost, resolveOperation } from "../models/index.js";

const BILLABLE_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "upscale",
  "media-transform",
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

function determineDomain(node, inputs = {}) {
  if (node.type === "video-generation") return "video";
  if (node.type === "llm") return "text";
  if (node.type === "media-transform") {
    const isVideo = Boolean(
      inputs.video_url || inputs.video || inputs.duration || inputs.mode === "video_to_video"
    );
    return isVideo ? "video" : "image";
  }
  return "image";
}

function operationForNode(node, inputs = {}) {
  const domain = determineDomain(node, inputs);
  return resolveOperation(inputs, domain);
}

function inputForNode(node, inputs = {}) {
  const operation = operationForNode(node, inputs);
  const isLLMNode = node.type === "llm";
  const nodeModel = resolveField(node, "model", inputs);
  const resolvedModel = isLLMNode ? (nodeModel || "gemini-2-0-flash") : (nodeModel || inputs.model);
  const messages = isLLMNode
    ? (inputs.messages || [{ role: "user", content: resolveField(node, "userPrompt", inputs) || inputs.prompt || "hello" }])
    : inputs.messages;

  return {
    ...inputs,
    messages,
    model: resolvedModel,
    modelKey: resolvedModel,
    providerId: resolveField(node, "provider", inputs) || inputs.provider,
    quality: inputs.quality || resolveField(node, "quality", inputs) || "standard",
    count: Number(inputs.count || resolveField(node, "count", inputs) || 1),
    durationSeconds: String(
      inputs.durationSeconds ||
      inputs.duration ||
      resolveField(node, "durationSeconds", inputs) ||
      resolveField(node, "duration", inputs) ||
      "5"
    ),
    resolution: inputs.resolution || resolveField(node, "resolution", inputs) || "720p",
    scale: String(
      inputs.upscaleScale ||
      inputs.factor ||
      resolveField(node, "upscaleScale", inputs) ||
      resolveField(node, "factor", inputs) ||
      "2"
    ),
    prompt: inputs.prompt || resolveField(node, "prompt", inputs) || "",
    image_url: inputs.image_url || inputs.source_url || resolveField(node, "image_url", inputs) || null,
    operation,
  };
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

    let costResult;
    if (typeof calculateCostFn === "function") {
      costResult = calculateCostFn(modelKey, billable.operation, billable.input);
    } else if (calculateCostFn && typeof calculateCostFn.calculateCost === "function") {
      costResult = calculateCostFn.calculateCost({
        modelKey,
        operation: billable.operation,
        input: billable.input,
      });
    }

    const credits = Math.max(0, Math.ceil(Number(costResult?.amount ?? costResult?.totalCredits ?? 0)));
    totalCredits += credits;
    breakdowns.push({
      ...billable,
      cost: {
        totalCredits: credits,
        amount: costResult?.amount || String(credits),
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
