import { V1StorageBridge } from "../v2/services/v1StorageBridge.js";

/** Canonical media statuses written to the V1 `media` table. */
export const MEDIA_WORKFLOW_STATUS = {
  PROCESSING: "processing",
  SUCCESS: "success",
  FAILED: "failed",
};

const PROVIDER_BACKED_NODE_TYPES = new Set([
  "image-generation",
  "video-generation",
  "upscale",
  "media-transform",
]);

function normalizeError(error, fallback = "Generation failed") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return error.message || fallback;
}

function inferStepId(nodeType, input = {}) {
  if (nodeType === "media-transform") return "EDIT";
  if (nodeType === "video-generation") return "VID";
  if (nodeType === "upscale") return "UPSCALE";
  return "GEN";
}

function buildDisplayName(input = {}) {
  const rawPrompt = (input?.prompt || "").trim();
  if (!rawPrompt) return "Untitled Generation";
  return rawPrompt.length > 60 ? `${rawPrompt.slice(0, 60)}…` : rawPrompt;
}

function buildGenerationConfig(nodeType, input = {}) {
  const isEdit =
    nodeType === "media-transform" || Boolean(input?.source_asset);

  return {
    prompt: input?.prompt || "",
    model: input?.model || "unknown",
    aspect_ratio: input?.aspect_ratio || "SQUARE",
    generation_type: isEdit ? "IMAGE_TO_IMAGE" : "TEXT_ONLY",
  };
}

export function normalizeNodeMediaOutputs(nodeConfig, output, { runId, nodeId } = {}) {
  if (!nodeConfig || !output) return [];

  const withContext = (asset, type) => ({
    ...asset,
    runId,
    nodeId,
    type: asset.type || type,
    metadata: { ...(asset.metadata || {}) },
  });

  if (nodeConfig.type === "image-generation") {
    return (output.assets || []).map((asset) => withContext(asset, "image"));
  }

  if (nodeConfig.type === "media-transform" && output.asset) {
    return [withContext(output.asset, "image")];
  }

  if (nodeConfig.type === "video-generation" && output.asset) {
    return [withContext(output.asset, "video")];
  }

  if (nodeConfig.type === "upscale" && output.enhancedAsset) {
    return [withContext(output.enhancedAsset, "image")];
  }

  return [];
}

/**
 * Single source of truth for V1 workflow + media lifecycle:
 *   Phase 1 — create placeholder (status=processing)
 *   Phase 2 — complete (status=success) or fail (status=failed)
 */
export class MediaWorkflowLifecycleService {
  constructor({ db = null } = {}) {
    this.bridge = db ? new V1StorageBridge({ db }) : null;
  }

  isProviderBackedNodeType(nodeType) {
    return PROVIDER_BACKED_NODE_TYPES.has(nodeType);
  }

  async resolveProjectId(userId, input = {}) {
    if (input.project_id || input.projectId) {
      return input.project_id || input.projectId;
    }
    if (!this.bridge || !userId) return null;
    return this.bridge.getOrCreateDefaultProject(userId);
  }

  /**
   * Phase 1 — create one workflow + media placeholder.
   * @returns {{ workflowId: string, mediaId: string } | null}
   */
  async startPlaceholder({
    userId,
    nodeType,
    input = {},
    runId = null,
    workflowId = null,
    displayName = null,
    workflowType = "GENERATION",
  }) {
    if (!this.bridge || !userId) return null;

    try {
      const projectId = await this.resolveProjectId(userId, input);
      if (!projectId) return null;

      const sessionId = input.session_id || input.sessionId || null;
      const stepId = inferStepId(nodeType, input);

      const { workflow, media } = await this.bridge.createV1Placeholder({
        userId,
        projectId,
        sessionId,
        displayName: displayName || buildDisplayName(input),
        workflowType,
        stepId,
        config: buildGenerationConfig(nodeType, input),
      });

      console.log(
        `[MediaWorkflowLifecycle] Started placeholder run=${runId || "n/a"} workflow=${workflow.id} media=${media.id}`
      );

      return { workflowId: workflow.id, mediaId: media.id };
    } catch (err) {
      console.error("[MediaWorkflowLifecycle] startPlaceholder failed:", err);
      return null;
    }
  }

  /**
   * Phase 1 — create N placeholders (e.g. image count).
   */
  async startPlaceholders({
    userId,
    nodeType,
    input = {},
    count = 1,
    runId = null,
    workflowId = null,
  }) {
    const total = Math.max(1, Number(count) || 1);
    const placeholders = [];

    for (let i = 0; i < total; i++) {
      const placeholder = await this.startPlaceholder({
        userId,
        nodeType,
        input,
        runId,
        workflowId,
      });
      if (placeholder) placeholders.push(placeholder);
    }

    return placeholders;
  }

  /**
   * Phase 1 — V2 node helper: derive count from node config and create placeholders.
   */
  async startPlaceholdersForNode({ runId, nodeConfig, resolvedInputs = {}, run }) {
    if (!this.isProviderBackedNodeType(nodeConfig?.type)) return [];

    const count =
      nodeConfig.type === "image-generation"
        ? Math.max(
            1,
            Number(resolvedInputs?.count ?? nodeConfig?.resolved_inputs?.count ?? 1)
          )
        : 1;

    return this.startPlaceholders({
      userId: run?.user_id || null,
      nodeType: nodeConfig.type,
      input: resolvedInputs,
      count,
      runId,
      workflowId: run?.workflow_id || null,
    });
  }

  /**
   * Phase 2 — mark one placeholder as success.
   */
  async completePlaceholder(mediaId, asset) {
    if (!this.bridge || !mediaId) return false;

    const url = (asset?.url || "").trim();
    if (!url) {
      return this.failPlaceholder(
        mediaId,
        "Provider returned success but no asset URL"
      );
    }

    try {
      await this.bridge.finalizeV1Media(
        mediaId,
        {
          url,
          width: asset?.width || 1024,
          height: asset?.height || 1024,
        },
        MEDIA_WORKFLOW_STATUS.SUCCESS
      );
      return true;
    } catch (err) {
      console.error("[MediaWorkflowLifecycle] completePlaceholder failed:", err);
      return false;
    }
  }

  /**
   * Phase 2 — mark one placeholder as failed.
   */
  async failPlaceholder(mediaId, error) {
    if (!this.bridge || !mediaId) return false;

    try {
      await this.bridge.failV1Media(mediaId, normalizeError(error));
      return true;
    } catch (err) {
      console.error("[MediaWorkflowLifecycle] failPlaceholder failed:", err);
      return false;
    }
  }

  /**
   * Phase 2 — finalize by explicit status (gateway compat).
   */
  async finalizePlaceholder(mediaId, asset, status = MEDIA_WORKFLOW_STATUS.SUCCESS, error = null) {
    if (status === MEDIA_WORKFLOW_STATUS.SUCCESS) {
      return this.completePlaceholder(mediaId, asset);
    }
    return this.failPlaceholder(mediaId, error || "Node execution failed");
  }

  /**
   * Phase 2 — zip placeholders with assets on success.
   */
  async completePlaceholders(placeholders = [], assets = []) {
    const results = [];

    for (let i = 0; i < placeholders.length; i++) {
      const placeholder = placeholders[i];
      const asset = assets[i];
      if (!placeholder?.mediaId) continue;

      const ok = await this.completePlaceholder(placeholder.mediaId, asset);
      results.push({ ...placeholder, asset, ok });
    }

    return results;
  }

  /**
   * Phase 2 — mark every placeholder failed (error path).
   */
  async failPlaceholders(placeholders = [], error) {
    const message = normalizeError(error);
    const results = [];

    for (const placeholder of placeholders) {
      if (!placeholder?.mediaId) continue;
      const ok = await this.failPlaceholder(placeholder.mediaId, message);
      results.push({ ...placeholder, ok });
    }

    return results;
  }

  /**
   * Phase 2 — V2 node helper: map node output to assets and finalize placeholders.
   */
  async finalizeOutputsForNode({
    placeholders = [],
    nodeConfig,
    output,
    runId,
    nodeId,
  }) {
    if (!this.isProviderBackedNodeType(nodeConfig?.type)) return [];

    const assets = normalizeNodeMediaOutputs(nodeConfig, output, { runId, nodeId });
    return this.completePlaceholders(placeholders, assets);
  }

  extractAsset(output, nodeType) {
    return this.bridge?.extractAsset(output, nodeType) ?? null;
  }

  getAspectRatio(width, height) {
    return this.bridge?.getAspectRatio(width, height) ?? "SQUARE";
  }
}

export default MediaWorkflowLifecycleService;
