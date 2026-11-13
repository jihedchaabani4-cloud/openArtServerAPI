/**
 * Identity Web Gateway (#identity/api)
 * Conforms to Rule 1, Rule 4, Rule 8, and Rule 13.
 */
import { Router } from "express";
import { AuthService, mapSessionUser } from "../internal/services/AuthService.js";
import { OAuthService } from "../internal/services/OAuthService.js";
import { clearAuthCookies } from "../internal/cookies.js";
import { rateLimit } from "../../../middleware/rateLimit.js";
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
      const container = await import("#container.js");
      if (container.walletService?.getBalance) {
        balance = await container.walletService.getBalance(user.id);
      }
    } catch {
      // Fallback during modularization
    }

    return res.status(200).json({ balance });
  } catch (err) {
    authLogger.error({ event: "auth.getWalletBalance_error", err: err?.message || String(err) }, "getWalletBalance error");
    return res.status(500).json({ error: "Internal server error." });
  }
}

export const identityRouter = Router();

identityRouter.post("/signup", rateLimit("signupIp"), signup);
identityRouter.post("/login", rateLimit("loginIp"), rateLimit("loginEmail"), login);
identityRouter.get("/google", googleRedirect);
identityRouter.get("/microsoft", microsoftRedirect);
identityRouter.get("/callback", googleCallback);
identityRouter.get("/me", getMe);
identityRouter.post("/logout", logout);
identityRouter.get("/wallet/balance", getWalletBalance);

export const authRouter = identityRouter;
export default identityRouter;
