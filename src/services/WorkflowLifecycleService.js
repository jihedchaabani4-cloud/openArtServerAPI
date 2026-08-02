/**
 * WorkflowLifecycleService
 *
 * Canonical name for workflow/media mutable lifecycle ownership.
 * The implementation currently extends WorkflowService to preserve existing
 * call sites while aligning feature-024 naming and service boundaries.
 */

import { WorkflowService } from "./WorkflowService.js";

export class WorkflowLifecycleService extends WorkflowService {}

export default WorkflowLifecycleService;