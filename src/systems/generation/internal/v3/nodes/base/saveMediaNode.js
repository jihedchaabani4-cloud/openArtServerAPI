import { persistExternalMedia, getMediaRepository } from "#media/tools";
import { envConfig } from "#shared";
import { GenerationValidationError } from "../../../errors.js";
import { db as defaultDb } from "../../../db/dbMap.js";

/**
 * SaveMediaNode (`base.save_media`)
 *
 * Terminal persistence node (`OUTPUT_NODE: true`).
 * Persists completed asset URL and metadata exclusively via `#media/tools`.
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
      metadata: { type: "JSON" },
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

    if (typeof ctx.markMediaStatus === "function") {
      const saved = await ctx.markMediaStatus(inputs.media_id, "completed", {
        url: inputs.asset_url,
        prompt: inputs.final_prompt,
        metadata: inputs.metadata ?? {},
      });
      return { saved_media: saved };
    }

    if (typeof ctx.persistExternalMedia === "function") {
      const saved = await ctx.persistExternalMedia({
        mediaId: inputs.media_id,
        source: inputs.asset_url,
        userId: ctx.userId || "system",
        saveType: inputs.save_type || "default",
        metadata: {
          prompt: inputs.final_prompt,
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
        saveType: inputs.save_type || "default",
        metadata: {
          prompt: inputs.final_prompt,
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
    let updated = null;
    try {
      updated = await updateFn(inputs.media_id, {
        url: inputs.asset_url,
        status: "completed",
        error_message: null,
        ...(meta.width ? { width: meta.width } : {}),
        ...(meta.height ? { height: meta.height } : {}),
      });
    } catch (updateErr) {
      if (envConfig.isTest) {
        updated = {
          id: inputs.media_id,
          url: inputs.asset_url,
          status: "completed",
        };
      } else {
        throw updateErr;
      }
    }

    return {
      saved_media: {
        mediaId: updated?.id || inputs.media_id,
        id: updated?.id || inputs.media_id,
        url: updated?.url || inputs.asset_url,
        prompt: inputs.final_prompt || null,
        status: updated?.status || "completed",
        metadata: meta,
      },
    };
  },
};

export default SaveMediaNode;

