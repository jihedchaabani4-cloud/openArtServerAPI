import { completeMedia, persistExternalMedia, MEDIA_WORKFLOW_STATUS } from "#media/tools";
import {
  GenerationValidationError,
  GenerationHoldExpiredError,
} from "../../../errors.js";

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
    status: "STRING",
    saved_media: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs = {}, ctx = {}) {
    if (!inputs.media_id) {
      throw new GenerationValidationError("media_id is required for base.save_media", { field: "media_id" });
    }
    if (!inputs.asset_url) {
      throw new GenerationValidationError("asset_url is required for base.save_media", { field: "asset_url" });
    }

    const mediaRole = inputs.media_role || ctx.mediaRole || "output";
    const saveType = inputs.save_type || ctx.saveType || "default";
    const normalizedMeta = inputs.metadata && typeof inputs.metadata === "object" ? inputs.metadata : {};

    if (typeof ctx.markMediaStatus === "function") {
      const saved = await ctx.markMediaStatus(inputs.media_id, MEDIA_WORKFLOW_STATUS.SUCCESS, {
        url: inputs.asset_url,
        prompt: inputs.final_prompt,
        role: mediaRole,
        save_type: saveType,
        ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
        metadata: normalizedMeta,
      });
      return { status: MEDIA_WORKFLOW_STATUS.SUCCESS, saved_media: saved };
    }

    if (typeof ctx.persistExternalMedia === "function") {
      const saved = await ctx.persistExternalMedia({
        mediaId: inputs.media_id,
        source: inputs.asset_url,
        userId: ctx.userId || "system",
        saveType,
        role: mediaRole,
        finalPrompt: inputs.final_prompt ?? null,
        characterDescription: inputs.character_description ?? null,
        workflowId: ctx.workflowId || null,
        stepId: ctx.stepId || null,
        metadata: {
          prompt: inputs.final_prompt,
          role: mediaRole,
          ...(inputs.character_description ? { character_description: inputs.character_description } : {}),
          ...normalizedMeta,
        },
      });
      return { status: MEDIA_WORKFLOW_STATUS.SUCCESS, saved_media: saved };
    }

    try {
      if (ctx.useExternalPersistence === true) {
        const saved = await persistExternalMedia({
          mediaId: inputs.media_id,
          source: inputs.asset_url,
          userId: ctx.userId || "system",
          saveType,
          role: mediaRole,
          finalPrompt: inputs.final_prompt ?? null,
          characterDescription: inputs.character_description ?? null,
          metadata: normalizedMeta,
          workflowId: ctx.workflowId || null,
          stepId: ctx.stepId || null,
          mediaRepository: ctx.mediaRepository || ctx.db?.media || null,
          workflowMediaRepository: ctx.workflowMediaRepository || ctx.db?.workflowMedia || null,
          uploadService: ctx.mediaUploadService || null,
        });
        return { status: MEDIA_WORKFLOW_STATUS.SUCCESS, saved_media: saved };
      }

      const saved = await completeMedia({
        mediaId: inputs.media_id,
        url: inputs.asset_url,
        finalPrompt: inputs.final_prompt ?? null,
        characterDescription: inputs.character_description ?? null,
        metadata: normalizedMeta,
        role: mediaRole,
        saveType,
        workflowId: ctx.workflowId || null,
        stepId: ctx.stepId || null,
        mediaRepository: ctx.mediaRepository || ctx.db?.media || null,
        workflowMediaRepository: ctx.workflowMediaRepository || ctx.db?.workflowMedia || null,
      });
      return { status: MEDIA_WORKFLOW_STATUS.SUCCESS, saved_media: saved };
    } catch (err) {
      if (err?.code === "HOLD_EXPIRED") {
        throw new GenerationHoldExpiredError(err.message, { mediaId: inputs.media_id });
      }
      throw err;
    }
  },
};

export default SaveMediaNode;
