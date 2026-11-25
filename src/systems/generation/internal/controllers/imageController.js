import { getGenerationServices } from "../services/serviceAccessor.js";
import { sendGenerationControllerError } from "./generationControllerHelpers.js";
import { createLogger } from "#shared";

const controllerLogger = createLogger("controller");

/**
 * POST /api/images/generated
 *
 * Thin HTTP Adapter — Image Generation.
 * Delegates request validation, ownership enforcement, placeholder persistence,
 * and job dispatch to GenerationRequestService.
 */
export async function generateImage(req, res) {
  try {
    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestGeneration({
      userId: req.user.id,
      mediaType: "image",
      stepId: "image_generation",
      useCaseId: "image-generation-v3",
      body: req.body,
    });
    return res.json(result);
  } catch (err) {
    return sendGenerationControllerError(res, err, {
      logger: controllerLogger,
      actionName: "generateImage",
      fallbackMessage: "Failed to generate image",
    });
  }
}

async function handleImageEdit(req, res, { editType, stepId, useCaseId, actionName, fallbackMessage }) {
  try {
    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId: req.user.id,
      editType,
      stepId,
      useCaseId,
      body: req.body,
    });
    return res.json(result);
  } catch (err) {
    return sendGenerationControllerError(res, err, {
      logger: controllerLogger,
      actionName,
      fallbackMessage,
    });
  }
}

/**
 * POST /api/images/relight — In-Place Image Relight.
 */
export async function relightImage(req, res) {
  return handleImageEdit(req, res, {
    editType: "relight",
    stepId: "image_relight",
    useCaseId: "image-relight-v3",
    actionName: "relightImage",
    fallbackMessage: "Failed to relight image",
  });
}

/**
 * POST /api/images/angles — In-Place Camera Angle Edit.
 */
export async function changeImageAngle(req, res) {
  return handleImageEdit(req, res, {
    editType: "angles",
    stepId: "image_angles",
    useCaseId: "image-angles-v3",
    actionName: "changeImageAngle",
    fallbackMessage: "Failed to adjust image angle",
  });
}

/**
 * POST /api/images/remove-background — In-Place Image Background Removal.
 */
export async function removeImageBackground(req, res) {
  return handleImageEdit(req, res, {
    editType: "remove_background",
    stepId: "image_remove_background",
    useCaseId: "image-remove-background-v3",
    actionName: "removeImageBackground",
    fallbackMessage: "Failed to remove image background",
  });
}

/**
 * POST /api/images/edit — General In-Place Image Edit.
 */
export async function editImage(req, res) {
  return handleImageEdit(req, res, {
    editType: "edit",
    stepId: "image_edit",
    useCaseId: "image-edit-v3",
    actionName: "editImage",
    fallbackMessage: "Failed to edit image",
  });
}
