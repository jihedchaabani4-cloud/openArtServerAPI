import { getGenerationServices } from "../services/serviceAccessor.js";
import {
  IMAGE_EDIT_MODELS,
  extractInlineEntityIds,
  parseRelightRequest,
  parseAnglesRequest,
  parseRemoveBackgroundRequest,
  parseImageEditRequest,
} from "../services/imageEditContract.js";
import {
  handleMediaGenerationRequest,
  sendGenerationControllerError,
} from "./generationControllerHelpers.js";
import { createLogger } from "#shared";
import { assertOwns, assertOwnsAny } from "#identity/tools";

const controllerLogger = createLogger("controller");

const IMAGE_FORBIDDEN_SOURCE_FIELDS = ["image_url", "source", "input_image", "source_url"];

/**
 * POST /api/images/generated
 *
 * Pure HTTP Controller — Image Generation.
 *
 * Architecture:
 *   - Accepts model-specific params as an opaque `parameters` object.
 *   - Validates HTTP request shape, permissions, and media-specific constraints.
 *   - Delegates domain orchestration, placeholder persistence, and job dispatch to GenerationRequestService.
 */
export async function generateImage(req, res) {
  return handleMediaGenerationRequest(req, res, {
    logger: controllerLogger,
    actionName: "generateImage",
    mediaType: "image",
    stepId: "image_generation",
    useCaseId: "image-generation-v1",
    forbiddenSourceFields: IMAGE_FORBIDDEN_SOURCE_FIELDS,
    directSourceMessage:
      "Direct image sources are not permitted. Upload the asset via /api/assets/upload and pass the returned workflow_id in parameters.input_image.",
    referencesDirectUrlMessage:
      "Direct image URLs are not permitted in references. Use workflow IDs only.",
    defaultMessages: {
      started: "Image generation started.",
      addCredits: "Add credits to generate your image.",
    },
    fallbackErrorMessage: "Failed to generate image",
  });
}

function handleImageEditError(res, err, actionName, fallbackMessage) {
  return sendGenerationControllerError(res, err, {
    logger: controllerLogger,
    actionName,
    fallbackMessage,
  });
}

/**
 * POST /api/images/relight
 *
 * Pure HTTP Controller — In-Place Image Relight.
 * Validates flat single-light settings, verifies workflow ownership,
 * and delegates to GenerationRequestService.requestImageEdit.
 */
export async function relightImage(req, res) {
  try {
    const parsed = parseRelightRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "relight",
      stepId: "image_relight",
      useCaseId: "image-relight-v3",
      model: IMAGE_EDIT_MODELS.relight,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      editSettings: parsed.editSettings,
      templateVars: parsed.templateVars,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Image relight started.",
        addCredits: "Add credits to relight your image.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "relightImage", "Failed to relight image");
  }
}

/**
 * POST /api/images/angles
 *
 * Pure HTTP Controller — In-Place Camera Angle Edit.
 * Validates camera pose settings, verifies workflow ownership,
 * and delegates to GenerationRequestService.requestImageEdit.
 */
export async function changeImageAngle(req, res) {
  try {
    const parsed = parseAnglesRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "angles",
      stepId: "image_angles",
      useCaseId: "image-angles-v3",
      model: IMAGE_EDIT_MODELS.angles,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      editSettings: parsed.editSettings,
      templateVars: parsed.templateVars,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Image angle adjustment started.",
        addCredits: "Add credits to adjust your image angle.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "changeImageAngle", "Failed to adjust image angle");
  }
}

/**
 * POST /api/images/remove-background
 *
 * Pure HTTP Controller — In-Place Image Background Removal (Direct 2-node V3, zero LLM).
 * Allows selecting between Bria remove-background models (`bria_remove_background_3_0` or
 * `bria_remove_background_guided`), verifies workflow ownership, and delegates to
 * GenerationRequestService.requestImageEdit.
 */
export async function removeImageBackground(req, res) {
  try {
    const parsed = parseRemoveBackgroundRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "remove_background",
      stepId: "image_remove_background",
      useCaseId: "image-remove-background-v3",
      model: parsed.model,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      editSettings: parsed.editSettings,
      templateVars: parsed.templateVars,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Background removal started.",
        addCredits: "Add credits to remove background from your image.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "removeImageBackground", "Failed to remove image background");
  }
}

/**
 * POST /api/images/edit
 *
 * Pure HTTP Controller — General In-Place Image Edit.
 * Allows selecting any active edit-capable image model, validates prompt + optional references,
 * verifies workflow and reference ownership, and delegates to GenerationRequestService.requestImageEdit.
 */
export async function editImage(req, res) {
  try {
    const parsed = parseImageEditRequest(req.body);
    const userId = req.user.id;

    await assertOwns("workflow", parsed.workflowId, userId);

    const { characterIds: inlineCharIds, elementIds: inlineElemIds } = extractInlineEntityIds(parsed.prompt);
    const allCharacterIds = [...new Set([...parsed.characters, ...inlineCharIds])];
    const allElementIds = [...new Set([...parsed.elements, ...inlineElemIds])];

    for (const refId of parsed.references) {
      await assertOwnsAny(["workflow", "character", "element", "media"], refId, userId);
    }
    for (const charId of allCharacterIds) {
      await assertOwnsAny(["character", "workflow"], charId, userId);
    }
    for (const elemId of allElementIds) {
      await assertOwnsAny(["element", "workflow"], elemId, userId);
    }

    const { generationRequestService } = getGenerationServices();
    const result = await generationRequestService.requestImageEdit({
      userId,
      workflowId: parsed.workflowId,
      editType: "edit",
      stepId: "image_edit",
      useCaseId: "image-edit-v3",
      model: parsed.model,
      prompt: parsed.prompt,
      userPrompt: parsed.userPrompt,
      references: parsed.references,
      characters: parsed.characters,
      elements: parsed.elements,
      editSettings: parsed.editSettings,
      parameters: parsed.parameters,
      defaultMessages: {
        started: "Image edit started.",
        addCredits: "Add credits to edit your image.",
      },
    });

    return res.json(result);
  } catch (err) {
    return handleImageEditError(res, err, "editImage", "Failed to edit image");
  }
}
