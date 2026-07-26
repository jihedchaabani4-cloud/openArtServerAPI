/**
 * BudgetEstimator
 * Establishes pre-check costing for a compiled execution graph.
 */

const PROVIDER_BACKED_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "upscale",
  "media-transform",
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
 * Estimates the credit cost of a single node.
 */
export async function estimateNodeCost(node, inputs = {}, pricingService = null) {
  if (!PROVIDER_BACKED_NODE_TYPES.has(node.type)) {
    return 0;
  }

  const model = resolveEstimationField(node, "model", inputs) || "default";
  const quality = resolveEstimationField(node, "quality", inputs) || "standard";

  // Determine quantity multiplier
  let quantity = 1;
  if (node.type === "image-generation") {
    quantity = Math.max(1, Number(resolveEstimationField(node, "count", inputs) ?? 1));
  } else if (node.type === "video-generation") {
    quantity = Math.max(1, Number(resolveEstimationField(node, "duration", inputs) ?? 5));
  } else if (node.type === "upscale") {
    quantity = Math.max(1, Number(resolveEstimationField(node, "factor", inputs) ?? 2));
  }

  // Fetch price from pricingService
  if (pricingService) {
    try {
      const priceInfo = await pricingService.getPrice(model, node.type, quality);
      return Number(priceInfo.creditCost) * quantity;
    } catch (err) {
      if (err.code === "PRICING_NOT_FOUND") {
        throw err;
      }
      console.warn(`[BudgetEstimator] Failed to fetch price for ${model}/${node.type}/${quality}, falling back to defaults:`, err.message);
    }
  }

  // Fallback defaults if pricingService is missing or fails
  let fallbackCost = 1;
  if (node.type === "image-generation") {
    fallbackCost = model.includes("pro") ? 12 : 5;
  } else if (node.type === "video-generation") {
    fallbackCost = 10; // 10 credits per second
  } else if (node.type === "upscale") {
    fallbackCost = 3;
  } else if (node.type === "media-transform") {
    fallbackCost = 10;
  }

  return fallbackCost * quantity;
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
