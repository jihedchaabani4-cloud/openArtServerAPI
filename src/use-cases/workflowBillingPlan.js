import { calculateCost as defaultCalculateCost } from "../models/index.js";

const BILLABLE_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "upscale",
  "media-transform",
]);

function resolveField(node, field, inputs = {}) {
  const binding = node.bindings?.[field];
  if (typeof binding === "string") {
    const match = binding.match(/^\$\{input\.(.+)\}$/);
    if (match && inputs[match[1]] !== undefined) return inputs[match[1]];
  }
  if (node.resolved_inputs?.[field] !== undefined) return node.resolved_inputs[field];
  if (node.config?.[field] !== undefined) return node.config[field];
  return inputs[field];
}

function operationForNode(node, inputs = {}) {
  const model = resolveField(node, "model", inputs);
  if (node.type === "video-generation") return "text_to_video";
  if (node.type === "image-generation") return "text_to_image";
  if (node.type === "media-transform") return "edit";
  if (node.type === "upscale") {
    return String(model || "").toLowerCase().includes("video")
      ? "video_upscale"
      : "image_upscale";
  }
  return String(node.type || "").replaceAll("-", "_");
}

function inputForNode(node, inputs = {}) {
  const operation = operationForNode(node, inputs);
  return {
    model: resolveField(node, "model", inputs) || inputs.model,
    modelKey: resolveField(node, "model", inputs) || inputs.model,
    providerId: resolveField(node, "provider", inputs) || inputs.provider,
    quality: resolveField(node, "quality", inputs) || inputs.quality || "standard",
    count: Number(resolveField(node, "count", inputs) || inputs.count || 1),
    durationSeconds: Number(resolveField(node, "durationSeconds", inputs) || resolveField(node, "duration", inputs) || inputs.durationSeconds || inputs.duration || 5),
    resolution: resolveField(node, "resolution", inputs) || inputs.resolution || "720p",
    scale: String(resolveField(node, "upscaleScale", inputs) || resolveField(node, "factor", inputs) || inputs.upscaleScale || inputs.factor || "2"),
    prompt: resolveField(node, "prompt", inputs) || inputs.prompt || "default prompt",
    image_url: resolveField(node, "image_url", inputs) || inputs.image_url || inputs.source_url || "https://cdn.openart.ai/placeholder.jpg",
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

export async function calculateWorkflowBillingPlan({ plan, inputs = {}, calculateCostFn = defaultCalculateCost } = {}) {
  const billableNodes = getBillableNodes(plan, inputs);
  const breakdowns = [];
  let totalCredits = 0;

  for (const billable of billableNodes) {
    const modelKey = billable.input.modelKey || billable.input.model;
    if (!modelKey) continue;

    let costResult;
    try {
      if (typeof calculateCostFn === "function") {
        costResult = calculateCostFn(modelKey, billable.operation, billable.input);
      } else if (calculateCostFn && typeof calculateCostFn.calculateCost === "function") {
        costResult = calculateCostFn.calculateCost({
          modelKey,
          operation: billable.operation,
          input: billable.input,
        });
      }
    } catch {
      // Fallback cost estimate if model / operation not in registry
      costResult = { amount: "10.000000", totalCredits: 10 };
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

