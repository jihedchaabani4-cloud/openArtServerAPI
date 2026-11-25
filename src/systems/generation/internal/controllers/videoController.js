import { createLogger } from "#shared";
import { handleMediaGenerationRequest } from "./generationControllerHelpers.js";

const controllerLogger = createLogger("video-controller");

const VIDEO_FORBIDDEN_SOURCE_FIELDS = [
  "image_url",
  "source",
  "input_image",
  "source_url",
  "video_url",
  "input_video",
];

/**
 * POST /api/video/generated
 *
 * Pure HTTP Controller — Video Generation.
 *
 * Architecture:
 *   - Accepts model-specific params as an opaque `parameters` object.
 *   - Validates HTTP request shape, permissions, and media-specific constraints.
 *   - Delegates domain orchestration, placeholder persistence, and job dispatch to GenerationRequestService.
 */
export async function generateVideo(req, res) {
  return handleMediaGenerationRequest(req, res, {
    logger: controllerLogger,
    actionName: "generateVideo",
    mediaType: "video",
    stepId: "video_generation",
    useCaseId: "video-generation-v1",
    forbiddenSourceFields: VIDEO_FORBIDDEN_SOURCE_FIELDS,
    directSourceMessage:
      "Direct media sources are not permitted. Upload the asset via /api/assets/upload and pass the returned workflow_id in parameters.",
    referencesDirectUrlMessage:
      "Direct URLs are not permitted in references. Use workflow IDs only.",
    defaultAspectRatio: "16:9",
    defaultMessages: {
      started: "Video generation started.",
      addCredits: "Add credits to generate your video.",
    },
    fallbackErrorMessage: "Failed to generate video",
  });
}
