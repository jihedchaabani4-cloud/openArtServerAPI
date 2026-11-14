/**
 * @owns System 5: Identity & Auth
 * AuthService
 * Handles signup, login, session extraction, and user account provisioning.
 */
import { authClient } from "../db/authClient.js";
import { ProfileRepository } from "../db/ProfileRepository.js";
import { setAuthCookies, clearAuthCookies } from "../cookies.js";
import { createLogger } from "#shared";
import { getWalletService } from "#billing/tools";
import { IdentityValidationError, IdentityAuthenticationError } from "../errors.js";

const authLogger = createLogger("auth_service");

export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validateAuthInput(body = {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!isValidEmail(email)) return { error: "Valid email is required." };
  if (!password || password.length < 6) {
    return { error: "Password must be at least 6 characters long." };
  }

  return { email, password };
}

export function mapSessionUser(user) {
  if (!user) return null;

  const meta = user.user_metadata || {};

  return {
    name: meta.full_name || meta.name || meta.user_name || user.email?.split("@")[0] || null,
    email: user.email || null,
    image: meta.avatar_url || meta.picture || null,
  };
}

export const AuthService = {
  /**
   * Resolves authenticated user from request cookies, refreshing the session if necessary.
   */
  async resolveUserFromCookies(req, res) {
    const accessToken = req.cookies?.access_token;
    const refreshToken = req.cookies?.refresh_token;

    if (accessToken) {
      const { data, error } = await authClient.getUser(accessToken);
      if (!error && data?.user) {
        return data.user;
      }
    }

    if (!refreshToken) {
      clearAuthCookies(res);
      return null;
    }

    const { data: refreshData, error: refreshError } = await authClient.refreshSession(refreshToken);

    if (refreshError || !refreshData?.session || !refreshData?.user) {
      clearAuthCookies(res);
      return null;
    }

    setAuthCookies(res, refreshData.session);
    return refreshData.user;
  },

  /**
   * Ensures the user profile exists and initializes user wallet.
   */
  async ensureUserAccount(userId, extra = {}) {
    let walletEnsure = Promise.resolve(null);
    try {
      const walletService = getWalletService();
      if (walletService?.ensureWallet) {
        walletEnsure = walletService.ensureWallet(userId);
      }
    } catch {
      // Wallet service lazy fallback during migration
    }

    await Promise.all([
      ProfileRepository.upsertProfile(userId, extra),
      walletEnsure,
    ]);
  },

  /**
   * Registers a new user.
   */
  async signup({ email, password, res }) {
    const { email: cleanEmail, password: cleanPassword, error } = validateAuthInput({ email, password });
    if (error) {
      throw new IdentityValidationError(error);
    }

    const { data, error: signUpError } = await authClient.signUp({ email: cleanEmail, password: cleanPassword });
    if (signUpError) {
      throw new IdentityValidationError(signUpError.message);
    }

    if (!data.user?.id) {
      throw new Error("Signup succeeded but no user was returned.");
    }

    await this.ensureUserAccount(data.user.id);

    if (!data.session) {
      return {
        requiresEmailConfirmation: true,
        user: { id: data.user.id },
      };
    }

    if (res) {
      setAuthCookies(res, data.session);
    }

    return {
      requiresEmailConfirmation: false,
      user: { id: data.user.id },
    };
  },

  /**
   * Logs in a user with password.
   */
  async login({ email, password, res }) {
    const { email: cleanEmail, password: cleanPassword, error } = validateAuthInput({ email, password });
    if (error) {
      throw new IdentityValidationError(error);
    }

    const { data, error: loginError } = await authClient.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword,
    });

    if (loginError) {
      throw new IdentityAuthenticationError(loginError.message);
    }

    if (!data.session || !data.user?.id) {
      throw new IdentityAuthenticationError("Invalid credentials.");
    }

    if (res) {
      clearAuthCookies(res);
      setAuthCookies(res, data.session);
    }

    return {
      user: { id: data.user.id },
    };
  },

  /**
   * Retrieves user profile DTO.
   */
  async getUserProfile(userId) {
    return ProfileRepository.findById(userId);
  },
};

export default AuthService;
