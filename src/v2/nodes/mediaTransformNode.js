/**
 * Media Transform Node
 * skill_aware: false | provider-backed: true
 *
 * Capabilities:
 *   - image_edit    : Edit an existing image (inpaint, style transfer, etc.)
 *   - image_to_image: Transform image to new image
 *   - image_variation: Generate variations of an image
 *   - video_to_video: Transform a video
 *
 * Requires source_asset (the media to transform)
 *
 * NOTE: Billing is managed by nodeExecutor.js at the orchestration level.
 * Do NOT call reserveNodeBilling / settleNodeBilling / rollbackNodeBilling here.
 */

import { selectProvider } from "../providers/router.js";
import { MEDIA_CAPABILITIES } from "../../workflows/workflowConstants.js";

export async function executeMediaTransform(inputs, ctx) {
  // Validate source_asset
  const sourceAsset = inputs.source_asset;
  if (!sourceAsset || !sourceAsset.url) {
    throw new Error("media-transform: source_asset.url is required");
  }

  // Resolve provider for transform mode
  const mode = inputs.mode || "image_edit";
  const model = inputs.model || null;

  // Map mode to capability
  const capabilityMap = {
    image_edit: MEDIA_CAPABILITIES.IMAGE_GENERATION,      // Same provider, different payload
    image_to_image: MEDIA_CAPABILITIES.IMAGE_GENERATION,
    image_variation: MEDIA_CAPABILITIES.IMAGE_GENERATION,
    video_to_video: MEDIA_CAPABILITIES.VIDEO_GENERATION,
  };

  const capabilityId = capabilityMap[mode];
  if (!capabilityId) {
    throw new Error(`media-transform: unsupported mode "${mode}"`);
  }

  // Select provider using the correct V2 router signature:
  // selectProvider(request, policy, forceProvider) → { adapter, decision }
  const { adapter, decision } = await selectProvider(
    { capabilityId, executionId: ctx.runId },
    {},                          // default policy
    ctx.forceProvider || null    // honour retry-based provider overrides
  );

  if (!adapter) {
    throw new Error(
      `media-transform: no provider available for mode "${mode}" (capabilityId=${capabilityId})`
    );
  }

  // Build transform payload
  const transformPayload = {
    capabilityId,
    prompt: inputs.prompt,
    image: sourceAsset.url,            // ← Source image (OBLIGATOIRE)
    image_url: sourceAsset.url,
    width: inputs.width ?? sourceAsset.width ?? 1024,
    height: inputs.height ?? sourceAsset.height ?? 1024,
    strength: inputs.strength ?? 0.75,
    references: inputs.references ?? [],
    mode,
    model,
  };

  // Execute
  const providerResult = await adapter.execute(transformPayload);

  // Extract output
  const outputItem = providerResult.outputs?.[0];
  if (!outputItem?.url) {
    throw new Error("media-transform: provider returned no output URL");
  }

  const providerId = decision?.selectedProvider || "unknown";

  // Build asset
  const asset = {
    id: outputItem.id || `${providerId}-${mode}-${Date.now()}`,
    url: outputItem.url,
    type: outputItem.type || (mode.includes("video") ? "video" : "image"),
    width: outputItem.width || inputs.width || 1024,
    height: outputItem.height || inputs.height || 1024,
    metadata: {
      ...(outputItem.metadata || {}),
      provider: providerId,
      mode,
      model: model || providerResult.model || null,
      source_asset_id: sourceAsset.id || null,
      prompt: inputs.prompt,
    },
  };

  return {
    asset,
    metadata: {
      provider: providerId,
      mode,
      model: model || providerResult.model || null,
      sourceAsset: {
        id: sourceAsset.id,
        url: sourceAsset.url,
      },
    },
  };
}
