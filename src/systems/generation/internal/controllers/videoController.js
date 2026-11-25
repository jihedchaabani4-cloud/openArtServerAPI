import { getGenerationServices } from "../services/serviceAccessor.js";
import { sendGenerationControllerError } from "./generationControllerHelpers.js";
import { createLogger } from "#shared";

const controllerLogger = createLogger("video-controller");

/**
 * POST /api/video/generated
 *
 * Thin HTTP Adapter — Video Generation.
 * Delegates request validation, ownership enforcement, placeholder persistence,
 * and job dispatch to GenerationRequestService.
 */
export async function generateVideo(req, res) {
  try {
    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestGeneration({
      userId: req.user.id,
      mediaType: "video",
      stepId: "video_generation",
      useCaseId: "video-generation-v3",
      body: req.body,
    });
    return res.json(result);
  } catch (err) {
    return sendGenerationControllerError(res, err, {
      logger: controllerLogger,
      actionName: "generateVideo",
      fallbackMessage: "Failed to generate video",
    });
  }
}
