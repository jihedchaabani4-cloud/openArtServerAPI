/**
 * MediaUploadErrors (Legacy Re-export)
 * Canonical implementation now lives in src/systems/media/internal/ingestion/MediaUploadErrors.js
 * accessible via #media/tools.
 */
import {
    ValidationError,
    UploadError,
    QuotaError,
    WORKFLOW_REFERENCE_QUOTA_PREFIX,
    WORKFLOW_REFERENCE_QUOTA_PATTERN,
    formatWorkflowReferenceQuotaMessage,
    isWorkflowReferenceQuotaError,
    createPayloadTooLargeError,
} from "#media/tools";

export {
    ValidationError,
    UploadError,
    QuotaError,
    WORKFLOW_REFERENCE_QUOTA_PREFIX,
    WORKFLOW_REFERENCE_QUOTA_PATTERN,
    formatWorkflowReferenceQuotaMessage,
    isWorkflowReferenceQuotaError,
    createPayloadTooLargeError,
};
