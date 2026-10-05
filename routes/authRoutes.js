import express from "express";
import { signup, login, googleRedirect, googleCallback, getMe, logout, microsoftRedirect, getWalletBalance } from "../controllers/authController.js";
import { rateLimit } from "../src/middleware/rateLimit.js";

const router = express.Router();

// Email / Password
router.post("/signup", rateLimit("signupIp"), signup);
router.post("/login", rateLimit("loginIp"), rateLimit("loginEmail"), login);

// OAuth flows (both return to the same callback)
router.get("/google", googleRedirect);
router.get("/microsoft", microsoftRedirect);
router.get("/callback", googleCallback);

// Session management
router.get("/me", getMe);
router.post("/logout", logout);
router.get("/wallet/balance", getWalletBalance);

export default router;
