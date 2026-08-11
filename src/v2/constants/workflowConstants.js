export const MEDIA_CAPABILITIES = Object.freeze({
  IMAGE_GENERATION: "image-generation",
  VIDEO_GENERATION: "video-generation",
  IMAGE_EDITING: "image-editing",
  VIDEO_EDITING: "video-editing",
  UPSCALE: "upscale",
  MEDIA_TRANSFORM: "media-transform",
});

export const FEATURE_STATUSES = Object.freeze({
  ACTIVE: "active",
  DISABLED: "disabled",
});

export const WORKFLOW_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_PROVIDER: "INVALID_PROVIDER",
  WORKFLOW_ERROR: "WORKFLOW_ERROR",
});

export function createWorkflowError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}
