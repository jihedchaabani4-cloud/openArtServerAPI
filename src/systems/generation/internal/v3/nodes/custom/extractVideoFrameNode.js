import { executeProvider } from "#models/tools";
import { GenerationValidationError, GenerationUpstreamError } from "../../../errors.js";

/**
 * ExtractVideoFrameNode (`custom.extract_video_frame`)
 *
 * Extracts the first or last keyframe URL from a video asset for chained
 * video continuation or vision inspection workflows via `#models/tools`.
 * Fails closed with a clear error if no frame extraction provider is available.
 */
export const ExtractVideoFrameNode = {
  type: "custom.extract_video_frame",
  category: "video",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      video_url: { type: "VIDEO_URL" },
    },
    optional: {
      position: { type: "STRING", default: "last" },
      provider: { type: "STRING", default: "video-frame-extractor" },
    },
  },

  RETURN_TYPES: {
    frame_url: "IMAGE_URL",
    metadata: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs, ctx = {}) {
    if (!inputs.video_url || typeof inputs.video_url !== "string") {
      throw new GenerationValidationError("video_url is required for custom.extract_video_frame", {
        field: "video_url",
      });
    }

    const position = inputs.position === "first" ? "first" : "last";

    if (typeof ctx.extractVideoFrame === "function") {
      const frameUrl = await ctx.extractVideoFrame(inputs.video_url, position);
      if (!frameUrl || typeof frameUrl !== "string") {
        throw new GenerationUpstreamError("Frame extractor returned an empty frame_url");
      }
      return {
        frame_url: frameUrl,
        metadata: { source_video: inputs.video_url, position },
      };
    }

    const providerName = inputs.provider || "video-frame-extractor";
    let res;
    try {
      res = await executeProvider(providerName, {
        video_url: inputs.video_url,
        position,
      });
    } catch (err) {
      throw new GenerationUpstreamError(
        `Video frame extraction provider "${providerName}" is unavailable or failed: ${err.message}`,
        {
          code: "FRAME_EXTRACTION_UNAVAILABLE",
          context: { video_url: inputs.video_url, position, provider: providerName },
        }
      );
    }

    const frameUrl = res?.frame_url || res?.url || res?.assets?.[0]?.url || null;
    if (!frameUrl || typeof frameUrl !== "string") {
      throw new GenerationUpstreamError(
        `Video frame extraction provider "${providerName}" did not return a valid frame_url`,
        {
          code: "FRAME_EXTRACTION_FAILED",
          context: { video_url: inputs.video_url, position },
        }
      );
    }

    return {
      frame_url: frameUrl,
      metadata: {
        source_video: inputs.video_url,
        position,
      },
    };
  },
};

export default ExtractVideoFrameNode;

