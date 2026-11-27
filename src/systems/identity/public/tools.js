/**
 * Identity Tools Interface (#identity/tools)
 * Conforms to Rule 1, Rule 4, and Rule 8 (Plain DTO contracts across boundaries).
 * Sealed surface: exports ONLY production middleware, ownership assertions, hooks, and typed errors.
 */
import { configureIdentityHooks } from "../internal/services/AuthService.js";
import {
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  configureOwnershipResolvers,
} from "../internal/services/OwnershipService.js";
import { authClient } from "../internal/db/authClient.js";
import {
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
} from "../internal/errors.js";

export { requireAuth } from "../internal/middleware/auth.js";
export { rateLimit } from "../internal/middleware/rateLimit.js";
export { walletRateLimit } from "../internal/middleware/walletRateLimit.js";

export {
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  configureOwnershipResolvers,
  configureIdentityHooks,
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
};

/**
 * Retrieves auth user DTO by ID via admin SDK.
 *
 * @param {string} userId
 * @returns {Promise<{ id: string, email: string|null }|null>}
 */
export async function getAuthUserById(userId) {
  if (!userId) return null;
  const { data, error } = await authClient.getUserById(userId);
  if (error || !data?.user) return null;
  return {
    id: data.user.id,
    email: data.user.email || null,
  };
}
