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

export {
  signup,
  login,
  googleRedirect,
  microsoftRedirect,
  googleCallback,
  getMe,
  logout,
  getWalletBalance,
};

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
