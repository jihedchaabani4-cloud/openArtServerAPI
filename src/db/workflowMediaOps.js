/**
 * Legacy Re-export for workflowMediaOps.js.
 * Canonical implementation now lives in src/systems/media/internal/db/workflowMediaOps.js
 * accessible via #media/tools.
 */
import {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
    markMediaStatus,
    markMediaFailed,
    createWorkflowWithMedia,
    createWorkflowWithMediaAtomic,
    appendMediaToWorkflow,
} from "#media/tools";

export {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
    markMediaStatus,
    markMediaFailed,
    createWorkflowWithMedia,
    createWorkflowWithMediaAtomic,
    appendMediaToWorkflow,
};
export default {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
    markMediaStatus,
    markMediaFailed,
    createWorkflowWithMedia,
    createWorkflowWithMediaAtomic,
    appendMediaToWorkflow,
};
