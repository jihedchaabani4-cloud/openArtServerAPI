import { MediaWorkflowLifecycleService } from "#platform/media/MediaLifecycleService.js";
import { createLogger } from "../logging/index.js";

const storageLogger = createLogger("storage");

/**
 * Thin adapter over MediaWorkflowLifecycleService for legacy gateway callers.
 * All workflow + media lifecycle logic lives in the service.
 */
export class WorkflowStorageGateway {
  constructor({ storageService = null, v1Db = null, lifecycleService = null } = {}) {
    this.storageService = storageService;
    this.lifecycle =
      lifecycleService ?? new MediaWorkflowLifecycleService({ db: v1Db });
  }

  async startPlaceholders(params) {
    return this.lifecycle.startPlaceholders(params);
  }

  async startPlaceholder(params) {
    return this.lifecycle.startPlaceholder(params);
  }

  async createMediaPlaceholder(params) {
    return this.lifecycle.startPlaceholder(params);
  }

  async finalizeMediaResult(mediaId, asset, status = "success", error = null) {
    return this.lifecycle.finalizePlaceholder(mediaId, asset, status, error);
  }

  async completePlaceholders(placeholders, assets) {
    return this.lifecycle.completePlaceholders(placeholders, assets);
  }

  async failPlaceholders(placeholders, error) {
    return this.lifecycle.failPlaceholders(placeholders, error);
  }

  async startPlaceholdersForNode(params) {
    return this.lifecycle.startPlaceholdersForNode(params);
  }

  async finalizeOutputsForNode(params) {
    return this.lifecycle.finalizeOutputsForNode(params);
  }

  /**
   * Persists the result of a V2 node in one step.
   * @deprecated Use startPlaceholder + completePlaceholder instead.
   */
  async persistMediaResult(result) {
    if (!result) return null;

    const bridge = this.lifecycle.bridge;
    if (bridge && result._v2Context) {
      try {
        const { runId, workflowId, userId, output, nodeType, input } =
          result._v2Context;
        const asset = this.lifecycle.extractAsset(output, nodeType);
        if (!asset) {
          console.warn(
            `[WorkflowStorageGateway] No asset in output for run ${runId}`
          );
          return null;
        }

        const stepId =
          workflowId === "character-sheet-v1" || input?.type === "character"
            ? "character_sheet"
            : "GEN";
        const displayName = `${workflowId} – ${runId.slice(0, 8)}`;
        const projectId = await this.lifecycle.resolveProjectId(userId, input);
        const sessionId = input.session_id || input.sessionId || null;
        const config = {
          prompt: input?.prompt || "",
          model: input?.model || asset.metadata?.model || "unknown",
          aspect_ratio: this.lifecycle.getAspectRatio(asset.width, asset.height),
          generation_type: "TEXT_ONLY",
        };

        const derivedWorkflowType =
          input?.workflow_type ||
          input?.workflowType ||
          (workflowId === "character-sheet-v1" || input?.type === "character"
            ? "CHARACTER"
            : workflowId === "element-sheet-v1"
              ? "ELEMENT_SHEET"
              : "GENERATION");

        const { workflow, media } = await bridge.createV1Workflow({
          userId,
          projectId,
          sessionId,
          displayName,
          workflowType: derivedWorkflowType,
          asset,
          config,
          stepId,
        });

        storageLogger.info(
          { workflowId: workflow.id, mediaId: media.id },
          `Persisted V1 workflow=${workflow.id} media=${media.id}`
        );
        return {
          ...result,
          status: "stored",
          v1WorkflowId: workflow.id,
          v1MediaId: media.id,
        };
      } catch (err) {
        storageLogger.error({ err }, `V1 persistence failed: ${err.message}`);
      }
    }

    if (result.storageUrl || result.url) {
      return { ...result, status: result.status || "stored" };
    }

    return { ...result, status: result.status || "pending" };
  }
}
