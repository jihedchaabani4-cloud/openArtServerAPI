/**
 * Identity Business System (#platform/identity)
 *
 * Public surface for authentication, authorization, ownership verification,
 * and security secret comparison.
 */

// Errors
export {
    IdentityError,
    IdentityAuthenticationError,
    IdentityForbiddenError,
    IdentityNotFoundError,
    IdentityValidationError,
} from "./IdentityErrors.js";

// Ownership Guards & Helpers
export {
    assertOwns,
    assertOwnsAny,
    toMediaIdList,
    setDb,
} from "../security/ownership.js";

// Security Comparison & Secret Utilities
export {
    safeCompareSecret,
} from "../security/secretComparison.js";

// Middleware
export {
    requireAuth,
    isInternalSecretAllowedRequest,
    isInternalSecretAllowedRoute,
    USER_ID_REGEX,
} from "../../middleware/auth.js";

export {
    requireAdmin,
} from "../../middleware/requireAdmin.js";

// Platform Authorization & Audit Services
export {
    AuthorizationService,
} from "../security/AuthorizationService.js";

export {
    TenantAccessService,
} from "../security/TenantAccessService.js";

export {
    AuditService,
} from "../security/AuditService.js";
