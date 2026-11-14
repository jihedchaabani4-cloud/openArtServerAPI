export const BILLING_MODES = Object.freeze({
  UPFRONT_RESERVE: "upfront-reserve",
  FREE: "free",
});

export const BILLING_STATUS = Object.freeze({
  NOT_REQUIRED: "not_required",
  RESERVED: "reserved",
  SETTLED: "settled",
  REFUNDED: "refunded",
  FAILED: "failed",
});

export const WORKFLOW_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const NODE_STATUS = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
});
