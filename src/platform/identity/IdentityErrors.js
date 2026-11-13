/**
 * Legacy Re-export for IdentityErrors.
 * Canonical implementation now lives in src/systems/identity/internal/errors.js
 * and is exposed through #identity/tools.
 */
export {
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
} from "../../systems/identity/public/tools.js";
