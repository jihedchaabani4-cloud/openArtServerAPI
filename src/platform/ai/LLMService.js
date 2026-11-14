/**
 * LLMService (Legacy Re-export)
 * @owns System 2: Models Management
 * Canonical implementation now lives in src/systems/models/internal/providers/LLMService.js
 * accessible via #models/tools.
 */
import {
  LLMService,
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
} from "#models/tools";

export {
  LLMService,
  llmService,
  BillingContextMissingError,
  ALLOWED_INTERNAL_REASONS,
};
export default llmService;
