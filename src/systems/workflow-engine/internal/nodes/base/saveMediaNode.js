import { envConfig } from "#shared";
import { requireAdapter } from "../../adapters.js";
import { WorkflowValidationError } from "../../errors.js";

const MEDIA_STATUS = Object.freeze({
  PROCESSING: "processing",
  SUCCESS: "success",
  FAILED: "failed",
});

/**
 * SaveMediaNode (`base.save_media`)
 *
 * Terminal persistence node (`OUTPUT_NODE: true`).
 * Persists completed asset URL, mediaRole, save_type, and metadata through
 * injected Media adapters (`persistExternalMedia` / `completeMedia`) so
 * `workflow-engine` never statically imports `#media/tools` or DB clients.
 */
export const SaveMediaNode = {
  type: "base.save_media",
  category: "output",
  OUTPUT_NODE: true,

  INPUT_TYPES: {
    required: {
      media_id: { type: "STRING" },
      asset_url: { type: "STRING" },
    },
    optional: {
      final_prompt: { type: "STRING" },
      character_description: { type: "STRING" },
      metadata: { type: "JSON" },
      media_role: { type: "STRING", default: "output" },
      save_type: { type: "STRING", default: "default" },
    },
  },

  RETURN_TYPES: {
    status: "STRING",
    saved_media: "JSON",
  },

  estimateCost: () => 0,

  /**
   * Pre-Wave-1 fail-fast adapter requirement check so misconfigured runs reject
   * before executing paid upstream AI nodes.
   */
  getRequiredAdapters(_plannedInputs = {}, ctx = {}) {
    if (typeof ctx?.markMediaStatus === "function") {
      return [];
    }
    const useExternalPersistence =
      ctx?.useExternalPersistence !== undefined
        ? Boolean(ctx.useExternalPersistence)
        : !envConfig.isTest;

    if (useExternalPersistence) {
      return ["persistExternalMedia"];
    }
    if (typeof ctx?.persistExternalMedia === "function" && typeof ctx?.completeMedia !== "function") {
      return ["persistExternalMedia"];
    }
    return ["completeMedia"];
  },

  async execute(inputs = {}, ctx = {}) {
    if (!inputs.media_id) {
      throw new WorkflowValidationError("media_id is required for base.save_media", { field: "media_id" });
    }
    if (!inputs.asset_url) {
      throw new WorkflowValidationError("asset_url is required for base.save_media", { field: "asset_url" });
    }

    const mediaRole = inputs.media_role || "output";
    const saveType = inputs.save_type || "default";
    const normalizedMeta = inputs.metadata && typeof inputs.metadata === "object" ? inputs.metadata : {};

    if (typeof ctx.markMediaStatus === "function") {
      const saved = await ctx.markMediaStatus(inputs.media_id, MEDIA_STATUS.SUCCESS, {
        url: inputs.asset_url,
        prompt: inputs.final_prompt,
        role: mediaRole,
        save_type: saveType,
        ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
        metadata: normalizedMeta,
      });
      return { status: MEDIA_STATUS.SUCCESS, saved_media: saved };
    }

    const useExternalPersistence =
      ctx.useExternalPersistence !== undefined
        ? Boolean(ctx.useExternalPersistence)
        : !envConfig.isTest;

    const explicitExternalOnly =
      !useExternalPersistence &&
      typeof ctx.persistExternalMedia === "function" &&
      typeof ctx.completeMedia !== "function";

    if (useExternalPersistence || explicitExternalOnly) {
      const persistExternalMediaFn = requireAdapter("persistExternalMedia", ctx);
      const saved = await persistExternalMediaFn({
        mediaId: inputs.media_id,
        source: inputs.asset_url,
        userId: ctx.userId || "system",
        saveType,
        role: mediaRole,
        finalPrompt: inputs.final_prompt ?? null,
        characterDescription: inputs.character_description ?? null,
        workflowId: ctx.workflowId || null,
        metadata: explicitExternalOnly
          ? {
              prompt: inputs.final_prompt,
              role: mediaRole,
              ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
              ...normalizedMeta,
            }
          : normalizedMeta,
        ...(explicitExternalOnly
          ? {}
          : {
              mediaRepository: ctx.mediaRepository || ctx.db?.media || null,
              workflowMediaRepository: ctx.workflowMediaRepository || ctx.db?.workflowMedia || null,
              uploadService: ctx.mediaUploadService || null,
            }),
      });
      return { status: MEDIA_STATUS.SUCCESS, saved_media: saved };
    }

    const completeMediaFn = requireAdapter("completeMedia", ctx);
    const saved = await completeMediaFn({
      mediaId: inputs.media_id,
      url: inputs.asset_url,
      finalPrompt: inputs.final_prompt ?? null,
      characterDescription: inputs.character_description ?? null,
      metadata: normalizedMeta,
      role: mediaRole,
      saveType,
      workflowId: ctx.workflowId || null,
      mediaRepository: ctx.mediaRepository || ctx.db?.media || null,
      workflowMediaRepository: ctx.workflowMediaRepository || ctx.db?.workflowMedia || null,
    });
    return { status: MEDIA_STATUS.SUCCESS, saved_media: saved };
  },
};

export default SaveMediaNode;
