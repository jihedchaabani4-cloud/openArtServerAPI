/**
 * Legacy Re-export for workflowMediaLinker.js.
 * Canonical implementation now lives in src/systems/media/internal/db/workflowMediaLinker.js
 * accessible via #media/tools.
 */
import {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
} from "#media/tools";

export {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
};
export default {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
};
