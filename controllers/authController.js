import { supabase } from "#lib/supabase.js";
import { walletService } from "#container.js";

const FRONTEND_URL = process.env.FRONTEND_URL;
const BASE_URL = process.env.BASE_URL;
const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
const POPUP_SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Login successful</title>
  </head>
  <body style="font-family: Arial, sans-serif; background: #05080f; color: white; display: grid; place-items: center; min-height: 100vh; margin: 0;">
    <script>
      (function () {
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: "oauth-login-success" }, ${JSON.stringify(FRONTEND_ORIGIN)});
          }
        } catch (error) {
          console.error("Popup auth message failed:", error);
        }

        window.close();
        setTimeout(function () {
          window.location.replace(${JSON.stringify(FRONTEND_URL)});
        }, 300);
      })();
    </script>
    <p style="opacity: 0.8;">Login successful. You can close this window.</p>
  </body>
</html>`;

// cross-origin cookies: frontend on Vercel, API on separate server
// sameSite=none + secure=true required for cookies to work cross-domain
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
};

const INITIAL_ACCOUNT_CREDITS = Number(
0
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
  // Use upsert to avoid race conditions on concurrent creation attempts
  const { data, error } = await supabase
    .from("profiles")
    .upsert({ id: userId, credits: INITIAL_ACCOUNT_CREDITS, ...extra }, { onConflict: ["id"] });

  if (error) throw error;
  return data?.[0] ?? null;
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

    // Clear any existing session before setting the new one
    // This ensures switching accounts always starts fresh
    clearAuthCookies(res);

    setAuthCookies(res, data.session);
    return res.status(200).json({ user: { id: data.user.id } });
  } catch (err) {
    console.error("[Auth] Login error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function googleRedirect(req, res) {
  try {
    const isPopup = req.query?.popup === "1";
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${BASE_URL}/api/auth/callback${isPopup ? "?popup=1" : ""}`,
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
    const isPopup = req.query?.popup === "1";
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        redirectTo: `${BASE_URL}/api/auth/callback${isPopup ? "?popup=1" : ""}`,
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
  const { code, popup } = req.query;

  if (!code) return res.status(400).json({ error: "Missing authorization code." });

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) return res.status(500).json({ error: error.message });

    const { session, user } = data;

    setAuthCookies(res, session);
    await ensureUserAccount(user.id, { email: user.email });

    if (popup === "1") {
      return res.status(200).send(POPUP_SUCCESS_HTML);
    }

    return res.redirect(`${FRONTEND_URL}/`);
  } catch (err) {
    console.error("[Auth] Google callback error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function getMe(req, res) {
  // Prevent browser from caching this response — critical after OAuth login
  // Without this, the browser returns a stale 304 ("not modified") and the
  // frontend never sees the newly logged-in user.
  res.setHeader("Cache-Control", "no-store");

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

export async function getWalletBalance(req, res) {
  try {
    const user = await resolveUserFromCookies(req, res);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const balance = await walletService.getBalance(user.id);

    return res.status(200).json({ balance });
  } catch (err) {
    console.error("[Auth] getWalletBalance error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
}
