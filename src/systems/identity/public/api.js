/**
 * Identity Web Gateway (#identity/api)
 * Conforms to Rule 1, Rule 4, Rule 8, and Rule 13.
 */
import { Router } from "express";
import { rateLimit } from "../internal/middleware/rateLimit.js";
import {
  signup,
  login,
  googleRedirect,
  microsoftRedirect,
  googleCallback,
  getMe,
  logout,
  getWalletBalance,
} from "../internal/controllers/authController.js";

export const authRouter = Router();

authRouter.post("/signup", rateLimit("signupIp"), signup);
authRouter.post("/login", rateLimit("loginIp"), rateLimit("loginEmail"), login);
authRouter.get("/google", googleRedirect);
authRouter.get("/microsoft", microsoftRedirect);
authRouter.get("/callback", googleCallback);
authRouter.get("/me", getMe);
authRouter.post("/logout", logout);
authRouter.get("/wallet/balance", getWalletBalance);
