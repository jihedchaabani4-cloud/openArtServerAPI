/**
 * Legacy Re-export for authRoutes.
 * Canonical gateway now lives in src/systems/identity/public/api.js (#identity/api)
 */
import {
  identityRouter,
  signup,
  login,
  googleRedirect,
  googleCallback,
  getMe,
  logout,
  microsoftRedirect,
  getWalletBalance,
} from "../src/systems/identity/public/api.js";

export {
  identityRouter,
  signup,
  login,
  googleRedirect,
  googleCallback,
  getMe,
  logout,
  microsoftRedirect,
  getWalletBalance,
};

export default identityRouter;
