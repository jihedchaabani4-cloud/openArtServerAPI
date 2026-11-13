/**
 * Legacy Re-export for authController.
 * Canonical handlers now live in src/systems/identity/public/api.js (#identity/api)
 */
export {
  signup,
  login,
  googleRedirect,
  microsoftRedirect,
  googleCallback,
  getMe,
  logout,
  getWalletBalance,
} from "../src/systems/identity/public/api.js";
