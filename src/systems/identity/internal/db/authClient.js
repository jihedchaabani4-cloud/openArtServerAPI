/**
 * Supabase Auth SDK Wrapper.
 * Strictly isolates Supabase Auth SDK calls inside internal/db/ per Rule 6 & Rule 12.
 */
import { createClient } from "@supabase/supabase-js";
import { envConfig } from "#shared";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

/**
 * Creates a request-bound Supabase client that stores OAuth PKCE verifiers
 * in httpOnly cookies, solving the stateless server auth problem.
 */
function createRequestBoundClient(req, res) {
  const storage = {
    getItem(key) {
      return req?.cookies?.[key] || null;
    },
    setItem(key, value) {
      if (!res) return;
      res.cookie(key, value, {
        httpOnly: true,
        secure: envConfig.isProduction,
        sameSite: "lax",
        path: "/",
        maxAge: 10 * 60 * 1000, // 10 minutes is plenty for OAuth flow
      });
    },
    removeItem(key) {
      if (!res) return;
      res.clearCookie(key, {
        httpOnly: true,
        secure: envConfig.isProduction,
        sameSite: "lax",
        path: "/",
      });
    },
  };

  return createClient(envConfig.supabaseUrl, envConfig.supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      storage,
    },
  });
}

export const authClient = {
  /**
   * Register a new user with email and password.
   */
  async signUp({ email, password }) {
    return supabase.auth.signUp({ email, password });
  },

  /**
   * Sign in an existing user with email and password.
   */
  async signInWithPassword({ email, password }) {
    return supabase.auth.signInWithPassword({ email, password });
  },

  /**
   * Initiate OAuth flow for a provider.
   */
  async signInWithOAuth({ provider, redirectTo, scopes, req, res }) {
    const client = req && res ? createRequestBoundClient(req, res) : supabase;
    return client.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        ...(scopes ? { scopes } : {}),
      },
    });
  },

  /**
   * Exchange an authorization code for an authenticated session.
   */
  async exchangeCodeForSession(code, req, res) {
    const client = req && res ? createRequestBoundClient(req, res) : supabase;
    return client.auth.exchangeCodeForSession(code);
  },

  /**
   * Retrieve user record from an active access token.
   */
  async getUser(accessToken) {
    return supabase.auth.getUser(accessToken);
  },

  /**
   * Retrieve user record by ID using server service-role client (used by checkout/profile lookup).
   */
  async getUserById(userId) {
    const client = supabaseAdmin || supabase;
    return client.auth.admin.getUserById(userId);
  },

  /**
   * Refresh a user session using a refresh token.
   */
  async refreshSession(refreshToken) {
    return supabase.auth.refreshSession({ refresh_token: refreshToken });
  },
};

export default authClient;
