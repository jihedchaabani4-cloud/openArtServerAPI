import { supabase } from "#lib/supabase.js";
import { walletService } from "#container.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BASE_URL = process.env.BASE_URL || "http://localhost:5000";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

const INITIAL_ACCOUNT_CREDITS = Number(
  process.env.INITIAL_WALLET_BALANCE ||
  process.env.DEFAULT_WALLET_BALANCE ||
  100
);

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function validateAuthInput(body = {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!isValidEmail(email)) return { error: "Valid email is required." };
  if (!password || password.length < 6) {
    return { error: "Password must be at least 6 characters long." };
  }

  return { email, password };
}

function setAuthCookies(res, session) {
  res.cookie("access_token", session.access_token, COOKIE_OPTS);
  res.cookie("refresh_token", session.refresh_token, COOKIE_OPTS);
}

function clearAuthCookies(res) {
  res.clearCookie("access_token", COOKIE_OPTS);
  res.clearCookie("refresh_token", COOKIE_OPTS);
}

function mapSessionUser(user) {
  if (!user) return null;

  const meta = user.user_metadata || {};

  return {
    name: meta.full_name || meta.name || meta.user_name || user.email?.split("@")[0] || null,
    email: user.email || null,
    image: meta.avatar_url || meta.picture || null,
  };
}

async function resolveUserFromCookies(req, res) {
  const accessToken = req.cookies?.access_token;
  const refreshToken = req.cookies?.refresh_token;

  if (accessToken) {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (!error && data?.user) {
      return data.user;
    }
  }

  if (!refreshToken) {
    clearAuthCookies(res);
    return null;
  }

  const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (refreshError || !refreshData?.session || !refreshData?.user) {
    clearAuthCookies(res);
    return null;
  }

  setAuthCookies(res, refreshData.session);
  return refreshData.user;
}

async function createProfile(userId, extra = {}) {
  const { data: existingProfile, error: existingProfileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (existingProfileError) throw existingProfileError;
  if (existingProfile) return existingProfile;

  const { error } = await supabase
    .from("profiles")
    .insert({ id: userId, credits: INITIAL_ACCOUNT_CREDITS, ...extra });

  if (error) throw error;
}

async function ensureUserAccount(userId, extra = {}) {
  await Promise.all([
    createProfile(userId, extra),
    walletService?.ensureWallet(userId) ?? Promise.resolve(null),
  ]);
}

export async function signup(req, res) {
  const { email, password, error } = validateAuthInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { data, error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) return res.status(400).json({ error: signUpError.message });

    if (!data.user?.id) {
      return res.status(500).json({ error: "Signup succeeded but no user was returned." });
    }

    await ensureUserAccount(data.user.id);

    if (!data.session) {
      return res.status(201).json({
        message: "Check your email for confirmation",
        user: { id: data.user.id },
      });
    }

    setAuthCookies(res, data.session);
    return res.status(201).json({ user: { id: data.user.id } });
  } catch (err) {
    console.error("[Auth] Signup error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function login(req, res) {
  const { email, password, error } = validateAuthInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });

    if (loginError) return res.status(401).json({ error: loginError.message });

    if (!data.session || !data.user?.id) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    setAuthCookies(res, data.session);
    return res.status(200).json({ user: { id: data.user.id } });
  } catch (err) {
    console.error("[Auth] Login error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

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

export async function microsoftRedirect(req, res) {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        redirectTo: `${BASE_URL}/api/auth/callback`,
        scopes: "openid profile email",
      },
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.redirect(data.url);
  } catch (err) {
    console.error("[Auth] Microsoft redirect error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function googleCallback(req, res) {
  const { code } = req.query;

  if (!code) return res.status(400).json({ error: "Missing authorization code." });

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) return res.status(500).json({ error: error.message });

    const { session, user } = data;

    setAuthCookies(res, session);
    await ensureUserAccount(user.id, { email: user.email });

    return res.redirect(`${FRONTEND_URL}/`);
  } catch (err) {
    console.error("[Auth] Google callback error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function getMe(req, res) {
  try {
    const user = await resolveUserFromCookies(req, res);

    if (!user) {
      return res.status(200).json({ user: null });
    }

    await ensureUserAccount(user.id, { email: user.email });

    return res.status(200).json({
      user: mapSessionUser(user),
    });
  } catch (err) {
    console.error("[Auth] getMe error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function logout(req, res) {
  clearAuthCookies(res);
  return res.status(200).json({ message: "Logged out successfully." });
}
