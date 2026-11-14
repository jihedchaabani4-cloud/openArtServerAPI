/**
 * @owns System 5: Identity & Auth
 * OAuthService
 * Handles OAuth redirects and callback exchanges for Google and Microsoft.
 */
import { authClient } from "../db/authClient.js";
import { AuthService } from "./AuthService.js";
import { setAuthCookies } from "./cookies.js";
import { envConfig } from "#shared";

export const OAuthService = {
  /**
   * Generates Google OAuth redirect URL.
   */
  async getGoogleOAuthUrl(req, res) {
    const { data, error } = await authClient.signInWithOAuth({
      provider: "google",
      redirectTo: `${envConfig.baseUrl}/api/auth/callback`,
      req,
      res,
    });
    if (error) throw error;
    return data?.url;
  },

  /**
   * Generates Microsoft OAuth redirect URL.
   */
  async getMicrosoftOAuthUrl(req, res) {
    const { data, error } = await authClient.signInWithOAuth({
      provider: "azure",
      redirectTo: `${envConfig.baseUrl}/api/auth/callback`,
      scopes: "openid profile email",
      req,
      res,
    });
    if (error) throw error;
    return data?.url;
  },

  /**
   * Exchanges authorization code for an authenticated session and provisions the user account.
   */
  async handleCallback(code, req, res) {
    if (!code) {
      throw new Error("Missing authorization code.");
    }

    const { data, error } = await authClient.exchangeCodeForSession(code, req, res);
    if (error) throw error;

    const { session, user } = data;
    if (res && session) {
      setAuthCookies(res, session);
    }

    if (user?.id) {
      await AuthService.ensureUserAccount(user.id, { email: user.email });
    }

    return {
      user,
      session,
      frontendUrl: `${envConfig.frontendUrl}/`,
    };
  },
};

export default OAuthService;
