import express from "express";
import { signup, login, googleRedirect, googleCallback, getMe, logout, microsoftRedirect } from "../controllers/authController.js";

const router = express.Router();

// Email / Password
router.post("/signup", signup);
router.post("/login", login);

// OAuth flows (both return to the same callback)
router.get("/google", googleRedirect);
router.get("/microsoft", microsoftRedirect);
router.get("/callback", googleCallback);

// Session management
router.get("/me", getMe);
router.post("/logout", logout);

export default router;
