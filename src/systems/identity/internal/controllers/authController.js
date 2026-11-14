/**
 * System 5: Identity & Auth — Auth Controller
 */
import { AuthService, mapSessionUser } from "../services/AuthService.js";
import { OAuthService } from "../services/OAuthService.js";
import { clearAuthCookies } from "../services/cookies.js";
import { getCreditBalance } from "#billing/tools";
import { createLogger } from "#shared";

const authLogger = createLogger("auth_api");

export async function signup(req, res) {
  try {
    const result = await AuthService.signup({
      email: req.body?.email,
      password: req.body?.password,
      res,
    });

    if (result.requiresEmailConfirmation) {
      return res.status(201).json({
        message: "Check your email for confirmation",
        user: result.user,
      });
    }

    return res.status(201).json({ user: result.user });
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    authLogger.error({ event: "auth.signup_error", err: err?.message || String(err) }, "Signup error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function login(req, res) {
  try {
    const result = await AuthService.login({
      email: req.body?.email,
      password: req.body?.password,
      res,
    });

    return res.status(200).json({ user: result.user });
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    authLogger.error({ event: "auth.login_error", err: err?.message || String(err) }, "Login error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function googleRedirect(req, res) {
  try {
    const url = await OAuthService.getGoogleOAuthUrl(req, res);
    return res.redirect(url);
  } catch (err) {
    authLogger.error({ event: "auth.google_redirect_error", err: err?.message || String(err) }, "Google redirect error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function microsoftRedirect(req, res) {
  try {
    const url = await OAuthService.getMicrosoftOAuthUrl(req, res);
    return res.redirect(url);
  } catch (err) {
    authLogger.error({ event: "auth.microsoft_redirect_error", err: err?.message || String(err) }, "Microsoft redirect error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function googleCallback(req, res) {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: "Missing authorization code." });
  }

  try {
    const result = await OAuthService.handleCallback(code, req, res);
    return res.redirect(result.frontendUrl);
  } catch (err) {
    authLogger.error({ event: "auth.callback_error", err: err?.message || String(err) }, "OAuth callback error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function getMe(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const user = await AuthService.resolveUserFromCookies(req, res);
    if (!user) {
      return res.status(200).json({ user: null });
    }

    await AuthService.ensureUserAccount(user.id, { email: user.email });

    return res.status(200).json({
      user: mapSessionUser(user),
    });
  } catch (err) {
    authLogger.error({ event: "auth.getMe_error", err: err?.message || String(err) }, "getMe error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export async function logout(req, res) {
  clearAuthCookies(res);
  return res.status(200).json({ message: "Logged out successfully." });
}

export async function getWalletBalance(req, res) {
  try {
    const user = await AuthService.resolveUserFromCookies(req, res);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let balance = 0;
    try {
      const result = await getCreditBalance({ userId: user.id });
      balance = result?.balance ?? 0;
    } catch {
      // Fallback if wallet service is not configured
    }

    return res.status(200).json({ balance });
  } catch (err) {
    authLogger.error({ event: "auth.getWalletBalance_error", err: err?.message || String(err) }, "getWalletBalance error");
    return res.status(500).json({ error: "Internal server error." });
  }
}
