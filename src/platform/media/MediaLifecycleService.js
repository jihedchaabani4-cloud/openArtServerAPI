/**
 * MediaWorkflowLifecycleService (Legacy Re-export)
 * @owns System 4: Media & Storage
 * Canonical implementation now lives in src/systems/media/internal/services/MediaLifecycleService.js
 * accessible via #media/tools.
 */
import {
    MediaWorkflowLifecycleService,
    MEDIA_WORKFLOW_STATUS,
    failWorkflowPendingMedia,
    normalizeNodeMediaOutputs,
} from "#media/tools";

export {
    MediaWorkflowLifecycleService,
    MEDIA_WORKFLOW_STATUS,
    failWorkflowPendingMedia,
    normalizeNodeMediaOutputs,
};
export default MediaWorkflowLifecycleService;
