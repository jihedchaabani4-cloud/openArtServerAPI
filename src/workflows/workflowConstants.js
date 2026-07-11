export const WORKFLOW_STATUSES = Object.freeze({
  QUEUED: "queued",
  PREPARING: "preparing",
  EXECUTING: "executing",
  POST_PROCESSING: "post_processing",
  COMPLETED: "completed",
  FAILED: "failed",
  RETRYABLE_FAILED: "retryable_failed",
  TERMINAL_FAILED: "terminal_failed",
});

export const CALLER_TYPES = Object.freeze({
  HTTP: "http",
  INTERNAL: "internal",
});

export const FEATURE_STATUSES = Object.freeze({
  ACTIVE: "active",
  HIDDEN: "hidden",
  RESTRICTED: "restricted",
  DISABLED: "disabled",
});

export const MEDIA_CAPABILITIES = Object.freeze({
  IMAGE_GENERATION: "image-generation",
  IMAGE_EDITING: "image-editing",
  VIDEO_GENERATION: "video-generation",
  VIDEO_EDITING: "video-editing",
});

export const WORKFLOW_STEP_TYPES = Object.freeze({
  PROCESSING_STEP: "processing-step",
  CAPABILITY: "capability",
});

export const DEFAULT_ASYNC_AFTER_SECONDS = 5;
