import { persistExternalMedia, getMediaRepository } from "#media/tools";
import {
  GenerationValidationError,
  GenerationHoldExpiredError,
} from "../../../errors.js";
import { db as defaultDb } from "../../../db/dbMap.js";

/**
 * SaveMediaNode (`base.save_media`)
 *
 * Terminal persistence node (`OUTPUT_NODE: true`).
 * Persists completed asset URL, mediaRole, save_type, and generation_config exclusively via `#media/tools`.
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
    saved_media: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs, ctx = {}) {
    if (!inputs.media_id) {
      throw new GenerationValidationError("media_id is required for base.save_media", { field: "media_id" });
    }
    if (!inputs.asset_url) {
      throw new GenerationValidationError("asset_url is required for base.save_media", { field: "asset_url" });
    }

    const mediaRole = inputs.media_role || ctx.mediaRole || "output";
    const saveType = inputs.save_type || ctx.saveType || "default";

    // Check if context or repo indicates the hold has already expired or media is already terminal "failed"
    if (ctx.holdExpired === true) {
      throw new GenerationHoldExpiredError(
        `Cannot complete media "${inputs.media_id}" because its credit hold has expired`,
        { mediaId: inputs.media_id }
      );
    }

    if (typeof ctx.markMediaStatus === "function") {
      const saved = await ctx.markMediaStatus(inputs.media_id, "completed", {
        url: inputs.asset_url,
        prompt: inputs.final_prompt,
        role: mediaRole,
        save_type: saveType,
        ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
        metadata: inputs.metadata ?? {},
      });
      return { saved_media: saved };
    }

    if (typeof ctx.persistExternalMedia === "function") {
      const saved = await ctx.persistExternalMedia({
        mediaId: inputs.media_id,
        source: inputs.asset_url,
        userId: ctx.userId || "system",
        saveType,
        role: mediaRole,
        metadata: {
          prompt: inputs.final_prompt,
          role: mediaRole,
          ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
          ...(inputs.metadata || {}),
        },
      });
      return { saved_media: saved };
    }

    if (ctx.useExternalPersistence === true) {
      const saved = await persistExternalMedia({
        mediaId: inputs.media_id,
        source: inputs.asset_url,
        userId: ctx.userId || "system",
        saveType,
        metadata: {
          prompt: inputs.final_prompt,
          role: mediaRole,
          ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
          ...(inputs.metadata || {}),
        },
      });
      return { saved_media: saved };
    }

    const repo = ctx.mediaRepository || ctx.db?.media || defaultDb?.media || getMediaRepository();
    const updateFn =
      typeof repo?.updateMedia === "function"
        ? repo.updateMedia.bind(repo)
        : typeof repo?.updateFields === "function"
          ? repo.updateFields.bind(repo)
          : null;

    if (!updateFn) {
      throw new GenerationValidationError("MediaRepository is not configured in #media/tools for base.save_media");
    }

    const meta = inputs.metadata && typeof inputs.metadata === "object" ? inputs.metadata : {};
    let existingMedia = null;
    if (typeof repo?.findById === "function") {
      existingMedia = await repo.findById(inputs.media_id).catch(() => null);
    }

    if (existingMedia?.status === "failed" || existingMedia?.hold_expired === true) {
      throw new GenerationHoldExpiredError(
        `Cannot complete media "${inputs.media_id}" because its placeholder is already in terminal "failed" status (hold expired or reaped)`,
        { mediaId: inputs.media_id }
      );
    }

    let mergedConfig = undefined;
    if (existingMedia?.generation_config && typeof existingMedia.generation_config === "object") {
      const baseConfig = { ...existingMedia.generation_config };
      if (inputs.final_prompt && baseConfig.prompt && inputs.final_prompt !== baseConfig.prompt) {
        baseConfig.prompt_optimized = inputs.final_prompt;
      } else {
        delete baseConfig.prompt_optimized;
      }
      if (inputs.character_description) {
        baseConfig.character_description = inputs.character_description;
      }
      if (meta.provider) {
        baseConfig.provider = meta.provider;
      }
      if (meta.model && !baseConfig.model) {
        baseConfig.model = meta.model;
      }
      mergedConfig = baseConfig;
    } else if (inputs.character_description || meta.provider || meta.model) {
      mergedConfig = {
        ...(inputs.final_prompt ? { prompt_optimized: inputs.final_prompt } : {}),
        ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
        ...(meta.provider ? { provider: meta.provider } : {}),
        ...(meta.model ? { model: meta.model } : {}),
      };
    }

    const updated = await updateFn(inputs.media_id, {
      url: inputs.asset_url,
      status: "completed",
      error_message: null,
      ...(meta.width || existingMedia?.width ? { width: meta.width || existingMedia.width } : {}),
      ...(meta.height || existingMedia?.height ? { height: meta.height || existingMedia.height } : {}),
      ...(mergedConfig && Object.keys(mergedConfig).length > 0 ? { generation_config: mergedConfig } : {}),
    });

    // If a parent DB workflow ID and workflowMedia repository exist, ensure the canonical mediaRole is linked
    const workflowMediaRepo = ctx.workflowMediaRepository || ctx.db?.workflowMedia || defaultDb?.workflowMedia;
    const parentWorkflowId = ctx.workflowId || existingMedia?.workflow_id || null;
    if (
      parentWorkflowId &&
      workflowMediaRepo &&
      typeof workflowMediaRepo.linkMedia === "function" &&
      mediaRole
    ) {
      await workflowMediaRepo.linkMedia(parentWorkflowId, inputs.media_id, mediaRole, ctx.workflowId || "save_media").catch(() => {});
    }

    return {
      saved_media: {
        mediaId: updated?.id || inputs.media_id,
        id: updated?.id || inputs.media_id,
        url: updated?.url || inputs.asset_url,
        prompt: inputs.final_prompt || null,
        role: mediaRole,
        save_type: saveType,
        ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
        status: updated?.status || "completed",
        metadata: meta,
      },
    };
  },
};

export default SaveMediaNode;

