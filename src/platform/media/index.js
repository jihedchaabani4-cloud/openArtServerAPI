/**
 * Media Platform Entry File (Legacy Re-export)
 *
 * Canonical implementation now lives in Media & Storage System (#media/tools).
 */

export {
    MediaService,
    MediaWorkflowLifecycleService,
    MEDIA_WORKFLOW_STATUS,
    failWorkflowPendingMedia,
    normalizeNodeMediaOutputs,
    resolveMediaMetadata,
    calculateAspectRatio,
} from "#media/tools";
