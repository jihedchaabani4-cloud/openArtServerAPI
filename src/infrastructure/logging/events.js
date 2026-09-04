/**
 * Standardized dot-separated event taxonomy for machine parsing and filtering.
 */

export const LogEvents = Object.freeze({
  // HTTP
  HTTP_REQUEST_STARTED: "http.request.started",
  HTTP_REQUEST_COMPLETED: "http.request.completed",
  HTTP_REQUEST_FAILED: "http.request.failed",

  // Auth
  AUTH_VERIFIED: "auth.verified",
  AUTH_FAILED: "auth.failed",

  // Controller
  CONTROLLER_ACTION_STARTED: "controller.action.started",
  CONTROLLER_ACTION_COMPLETED: "controller.action.completed",

  // UseCase
  USECASE_STARTED: "usecase.started",
  USECASE_COMPLETED: "usecase.completed",
  USECASE_FAILED: "usecase.failed",

  // Models
  MODELS_MODEL_RESOLVED: "models.model.resolved",
  MODELS_COST_CALCULATED: "models.cost.calculated",

  // Billing & Wallet
  BILLING_COST_CALCULATED: "billing.cost.calculated",
  WALLET_HOLD_REQUESTED: "wallet.hold.requested",
  WALLET_HOLD_CREATED: "wallet.hold.created",
  WALLET_HOLD_RELEASED: "wallet.hold.released",
  WALLET_CHARGE_REQUESTED: "wallet.charge.requested",
  WALLET_CHARGE_COMPLETED: "wallet.charge.completed",
  WALLET_CHARGE_FAILED: "wallet.charge.failed",

  // Queue & Worker
  JOB_QUEUED: "job.queued",
  JOB_STARTED: "job.started",
  JOB_COMPLETED: "job.completed",
  JOB_FAILED: "job.failed",

  // Workflow & Nodes
  WORKFLOW_STARTED: "workflow.started",
  WORKFLOW_COMPLETED: "workflow.completed",
  WORKFLOW_FAILED: "workflow.failed",
  WORKFLOW_NODE_STARTED: "workflow.node.started",
  WORKFLOW_NODE_COMPLETED: "workflow.node.completed",
  WORKFLOW_NODE_FAILED: "workflow.node.failed",

  // Provider
  PROVIDER_REQUEST_STARTED: "provider.request.started",
  PROVIDER_REQUEST_COMPLETED: "provider.request.completed",
  PROVIDER_REQUEST_FAILED: "provider.request.failed",

  // Media & Storage
  MEDIA_UPLOAD_STARTED: "media.upload.started",
  MEDIA_UPLOAD_COMPLETED: "media.upload.completed",
  MEDIA_STATUS_UPDATED: "media.status.updated",

  // System
  SYSTEM_BOOTSTRAP_COMPLETED: "system.bootstrap.completed",
  SYSTEM_SHUTDOWN: "system.shutdown",
});

export default LogEvents;
