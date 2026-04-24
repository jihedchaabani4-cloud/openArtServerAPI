import { createClient } from "@supabase/supabase-js";
import { supabase } from "#lib/supabase.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BASE_URL     = process.env.BASE_URL     || "http://localhost:5000";

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === "production",
  sameSite: "lax",
};

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validateAuthInput(body = {}) {
  const email    = typeof body.email    === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!isValidEmail(email))            return { error: "Valid email is required." };
  if (!password || password.length < 6) return { error: "Password must be at least 6 characters long." };

  return { email, password };
}


function setAuthCookies(res, session) {
  res.cookie("access_token",  session.access_token,  COOKIE_OPTS);
  res.cookie("refresh_token", session.refresh_token, COOKIE_OPTS);
}

async function createProfile(userId, extra = {}) {
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: userId, credits: 0, ...extra }, { onConflict: "id" });

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email / Password Controllers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /auth/signup
 * Body: { email, password }
 */
export async function signup(req, res) {
  const { email, password, error } = validateAuthInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { data, error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) return res.status(400).json({ error: signUpError.message });

    if (!data.user?.id) {
      return res.status(500).json({ error: "Signup succeeded but no user was returned." });
    }

    await createProfile(data.user.id);

    if (!data.session) {
      return res.status(201).json({
        message: "Check your email for confirmation",
        user: { id: data.user.id },
      });
    }

    // Set secure httpOnly cookies
    setAuthCookies(res, data.session);

    return res.status(201).json({ user: { id: data.user.id } });

  } catch (err) {
    console.error("[Auth] Signup error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * POST /auth/login
 * Body: { email, password }
 */
export async function login(req, res) {
  const { email, password, error } = validateAuthInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });

    if (loginError) return res.status(401).json({ error: loginError.message });

    if (!data.session || !data.user?.id) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Set secure httpOnly cookies
    setAuthCookies(res, data.session);

    return res.status(200).json({ user: { id: data.user.id } });

  } catch (err) {
    console.error("[Auth] Login error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth Controllers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /auth/google
 * Redirects the user to Google's OAuth consent screen via Supabase.
 */
export async function googleRedirect(req, res) {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${BASE_URL}/api/auth/callback`,
      },
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.redirect(data.url);

  } catch (err) {
    console.error("[Auth] Google redirect error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * GET /auth/microsoft
 * Redirects the user to Microsoft's OAuth consent screen via Supabase.
 */
export async function microsoftRedirect(req, res) {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
provider: "azure",
      options: {
        redirectTo: `${BASE_URL}/api/auth/callback`,
        scopes: "openid profile email", // زيد openid
      },
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.redirect(data.url);

  } catch (err) {
    console.error("[Auth] Microsoft redirect error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * GET /auth/callback
 * Supabase redirects here after OAuth login (Google, Microsoft, etc.).
 * Exchanges the code for a session, sets httpOnly cookies, creates profile.
 */
export async function googleCallback(req, res) {
  const { code } = req.query;

  if (!code) return res.status(400).json({ error: "Missing authorization code." });

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) return res.status(500).json({ error: error.message });

    const { session, user } = data;

    // Set secure httpOnly cookies
    setAuthCookies(res, session);

    // Create or update profile (email from OAuth provider)
    await createProfile(user.id, { email: user.email });

    return res.redirect(`${FRONTEND_URL}/projects`);

  } catch (err) {
    console.error("[Auth] Google callback error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * GET /auth/me
 * Returns the current user from the access_token cookie.
 */
export async function getMe(req, res) {
  const token = req.cookies?.access_token;

  if (!token) return res.status(401).json({ error: "Unauthorized." });

  try {
    const userClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const { data, error } = await userClient.auth.getUser();

    if (error || !data.user) {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    const user = data.user;

    // 🔥 الحل هنا
    await createProfile(user.id, { email: user.email });

    return res.status(200).json({ user });

  } catch (err) {
    console.error("[Auth] getMe error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

/**
 * POST /auth/logout
 * Clears auth cookies.
 */
export async function logout(req, res) {
  res.clearCookie("access_token",  COOKIE_OPTS);
  res.clearCookie("refresh_token", COOKIE_OPTS);
  return res.status(200).json({ message: "Logged out successfully." });
}