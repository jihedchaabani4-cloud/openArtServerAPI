import { calculateCost, resolveOperation } from "../../models/index.js";

const PROVIDER_BACKED_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "upscale",
  "media-transform",
  "llm",
]);

/**
 * Resolves a field value for a node during pre-check estimation,
 * handling both static inputs and simple input bindings.
 */
function resolveEstimationField(node, field, inputs = {}) {
  // 1. Dynamic bindings to input (e.g. "${input.count}")
  const binding = node.bindings?.[field];
  if (typeof binding === "string") {
    const match = binding.match(/^\$\{input\.(.+)\}$/);
    if (match) {
      const inputKey = match[1];
      if (inputs[inputKey] !== undefined) {
        return inputs[inputKey];
      }
    }
  }

  // 2. Static config / compiled defaults
  if (node.resolved_inputs?.[field] !== undefined) {
    return node.resolved_inputs[field];
  }

  return undefined;
}

/**
 * Estimates the credit cost of a single node strictly via Models Management System.
 */
export async function estimateNodeCost(node, inputs = {}, pricingService = null) {
  if (!PROVIDER_BACKED_NODE_TYPES.has(node.type)) {
    return 0;
  }

  let model = resolveEstimationField(node, "model", inputs) || node.config?.model;
  let domain = "image";
  let defaultOp = "text_to_image";

  if (node.type === "image-generation") {
    model = model || "nanobana";
    domain = "image";
    defaultOp = "text_to_image";
  } else if (node.type === "video-generation") {
    model = model || "kling-v3";
    domain = "video";
    defaultOp = "text_to_video";
  } else if (node.type === "upscale") {
    model = model || "nanobana";
    domain = "image";
    defaultOp = "image_upscale";
  } else if (node.type === "media-transform") {
    const isVideo = Boolean(
      inputs.video_url || inputs.video || inputs.duration || inputs.mode === "video_to_video"
    );
    domain = isVideo ? "video" : "image";
    model = model || (isVideo ? "kling-v3" : "nanobana");
    defaultOp = isVideo ? "video_to_video" : "edit";
  } else if (node.type === "llm") {
    model = model || "llama-3-3-70b";
    domain = "text";
    defaultOp = "chat_completion";
  }

  const op = resolveOperation(inputs, domain) || defaultOp;
  const costResult = calculateCost(model, op, inputs);
  const costNumber = parseFloat(costResult.amount);

  if (isNaN(costNumber) || costNumber < 0) {
    throw new Error(`[BudgetEstimator] Invalid calculated cost "${costResult.amount}" for model "${model}" (${op})`);
  }

  return costNumber;
}

/**
 * Estimates total workflow cost by summing up all provider-backed nodes.
 */
export async function estimateWorkflowCost(compiledPlan, inputs = {}, pricingService = null) {
  let totalCost = 0;
  if (!compiledPlan || !Array.isArray(compiledPlan.nodes)) {
    return 0;
  }

  for (const node of compiledPlan.nodes) {
    const cost = await estimateNodeCost(node, inputs, pricingService);
    totalCost += cost;
  }

  return totalCost;
}
