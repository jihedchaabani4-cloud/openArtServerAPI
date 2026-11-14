/**
 * Supabase Auth SDK Wrapper.
 * Strictly isolates Supabase Auth SDK calls inside internal/db/ per Rule 6 & Rule 12.
 */
import { supabase, supabaseAdmin, createRequestBoundClient } from "#lib/supabase.js";

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
   * Retrieve user record by ID using admin SDK (service role).
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
