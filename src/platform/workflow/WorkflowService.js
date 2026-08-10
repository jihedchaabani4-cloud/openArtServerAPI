/**
 * WorkflowService (platform layer)
 * Canonical domain owner of all workflow lifecycle operations.
 *
 * This file re-exports WorkflowLifecycleService which extends WorkflowServiceBase.
 * Feature: 026-backend-platform-layer-refactor
 * Original: src/services/WorkflowLifecycleService.js + src/services/WorkflowService.js
 */

import { WorkflowService as WorkflowServiceBase } from "./WorkflowServiceBase.js";

export class WorkflowLifecycleService extends WorkflowServiceBase {}

// Re-export under both names for backward compatibility in container.js
export { WorkflowLifecycleService as WorkflowService };
export default WorkflowLifecycleService;