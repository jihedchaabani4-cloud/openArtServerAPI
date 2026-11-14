/**
 * Identity Tools Interface (#identity/tools)
 * Conforms to Rule 1, Rule 4, and Rule 8 (Plain DTO contracts across boundaries).
 */
import { AuthService } from "../internal/services/AuthService.js";
import { ProfileRepository } from "../internal/db/ProfileRepository.js";
import { OwnershipService } from "../internal/services/OwnershipService.js";
import { authClient } from "../internal/db/authClient.js";
import {
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
} from "../internal/errors.js";

// Re-export middleware and utilities for cross-system consumer convenience
export {
  requireAuth,
  isInternalSecretAllowedRequest,
  isInternalSecretAllowedRoute,
  USER_ID_REGEX,
} from "../internal/middleware/auth.js";

export { requireAdmin } from "../internal/middleware/requireAdmin.js";
export {
  rateLimit,
  resetLimitersForTest,
  setLimiterForTest,
} from "../internal/middleware/rateLimit.js";
export { RATE_LIMIT_POLICIES } from "#shared";
export { walletRateLimit } from "../internal/middleware/walletRateLimit.js";
export { safeCompareSecret } from "../internal/services/secretComparison.js";


export {
  IdentityError,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
};

export const identityTools = {
  /**
   * Verifies an active session from an incoming HTTP request or cookie payload.
   *
   * @param {Object} req - Request object containing cookies or headers
   * @returns {Promise<{ userId: string, email: string|null, role: string }>}
   */
  async verifySession(req) {
    if (!req) {
      throw new IdentityAuthenticationError("Request context is required for session verification.");
    }

    if (req.user?.id) {
      return {
        userId: req.user.id,
        email: req.user.email || null,
        role: req.user.role || "user",
      };
    }

    // Check Bearer token in headers
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      const { data, error } = await authClient.getUser(token);
      if (!error && data?.user?.id) {
        return {
          userId: data.user.id,
          email: data.user.email || null,
          role: data.user.role || "user",
        };
      }
    }

    // Check cookies
    const user = await AuthService.resolveUserFromCookies(req);
    if (!user || !user.id) {
      throw new IdentityAuthenticationError("No valid session found.");
    }

    return {
      userId: user.id,
      email: user.email || null,
      role: user.role || "user",
    };
  },

  /**
   * Retrieves user profile DTO.
   *
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async getUserProfile(userId) {
    if (!userId) return null;
    return ProfileRepository.findById(userId);
  },

  /**
   * Retrieves auth user DTO by ID via admin SDK.
   *
   * @param {string} userId
   * @returns {Promise<{ id: string, email: string|null }|null>}
   */
  async getAuthUserById(userId) {
    if (!userId) return null;
    const { data, error } = await authClient.getUserById(userId);
    if (error || !data?.user) return null;
    return {
      id: data.user.id,
      email: data.user.email || null,
    };
  },

  /**
   * Asserts that a user owns the given resource.
   */
  assertOwns: (resourceType, id, userId) => OwnershipService.assertOwns(resourceType, id, userId),

  /**
   * Asserts that a user owns any of the allowed resource types for the given ID.
   */
  assertOwnsAny: (resourceTypes, id, userId) => OwnershipService.assertOwnsAny(resourceTypes, id, userId),

  /**
   * Normalizes media or reference values into string IDs.
   */
  toMediaIdList: (value) => OwnershipService.toMediaIdList(value),

  /**
   * Test fixture helper to inject mock DB repository.
   */
  setDb: (dbInstance) => OwnershipService.setDb(dbInstance),
};

export const {
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  setDb,
  verifySession,
  getUserProfile,
  getAuthUserById,
} = identityTools;

export default identityTools;
