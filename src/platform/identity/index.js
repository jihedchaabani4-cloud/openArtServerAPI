/**
 * Legacy Re-export for Identity Business System (#platform/identity).
 * Canonical gateway now lives in src/systems/identity/public/tools.js (#identity/tools).
 */

export {
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  setDb,
  safeCompareSecret,
  requireAuth,
  requireAdmin,
  isInternalSecretAllowedRequest,
  isInternalSecretAllowedRoute,
  USER_ID_REGEX,
  verifySession,
  getUserProfile,
  identityTools,
  identityTools as default,
} from "../../systems/identity/public/tools.js";
