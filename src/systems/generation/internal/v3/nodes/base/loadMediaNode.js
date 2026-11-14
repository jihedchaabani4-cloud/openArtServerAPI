import { getMediaById, getMediaUrls } from "#media/tools";
import { assertOwnsAny } from "#identity/tools";
import { GenerationNotFoundError, GenerationValidationError } from "../../../errors.js";

/**
 * LoadMediaNode (`base.load_media`)
 *
 * Resolves a media or workflow ID into a verified CDN URL and metadata DTO
 * via `#media/tools` and `#identity/tools`.
 */
export const LoadMediaNode = {
  type: "base.load_media",
  category: "media",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      media_id: { type: "STRING" },
    },
    optional: {
      verify_ownership: { type: "BOOLEAN", default: true },
    },
  },

  RETURN_TYPES: {
    media_url: "IMAGE_URL",
    video_url: "VIDEO_URL",
    metadata: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs, ctx = {}) {
    const rawId = typeof inputs.media_id === "string" ? inputs.media_id.trim() : "";
    if (!rawId) {
      throw new GenerationValidationError("media_id must be a non-empty string", { field: "media_id" });
    }

    // Direct URL pass-through if already resolved
    if (rawId.startsWith("http://") || rawId.startsWith("https://")) {
      return {
        media_url: rawId,
        video_url: rawId,
        metadata: { id: rawId, url: rawId, status: "completed" },
      };
    }

    const userId = ctx.userId || null;
    const verifyOwnership = inputs.verify_ownership === undefined ? true : inputs.verify_ownership === true;
    if (userId && verifyOwnership === true) {
      const assertFn = ctx.assertOwnsAny || assertOwnsAny;
      await assertFn(["media", "workflow"], rawId, userId);
    }

    const getByIdFn = ctx.getMediaById || getMediaById;
    const getUrlsFn = ctx.getMediaUrls || getMediaUrls;

    let record = await getByIdFn(rawId);
    if (!record) {
      const list = await getUrlsFn([rawId]);
      if (Array.isArray(list) && list.length > 0) {
        record = list[0];
      }
    }

    const resolvedUrl = record?.url || null;
    if (!resolvedUrl) {
      throw new GenerationNotFoundError(`Media "${rawId}" not found or has no resolved URL`, {
        resourceId: rawId,
      });
    }

    return {
      media_url: resolvedUrl,
      video_url: resolvedUrl,
      metadata: {
        id: record.id || record.mediaId || rawId,
        url: resolvedUrl,
        width: record.width || null,
        height: record.height || null,
        status: record.status || "completed",
      },
    };
  },
};

export default LoadMediaNode;
