/**
 * Cross-origin cookie management for identity sessions.
 */
import { envConfig } from "#shared";

export const COOKIE_OPTS = {
  httpOnly: true,
  secure: envConfig.isProduction,
  sameSite: envConfig.isProduction ? "none" : "lax",
  path: "/",
};

export function setAuthCookies(res, session) {
  if (!res || !session) return;
  res.cookie("access_token", session.access_token, COOKIE_OPTS);
  res.cookie("refresh_token", session.refresh_token, COOKIE_OPTS);
}

export function clearAuthCookies(res) {
  if (!res) return;
  res.clearCookie("access_token", COOKIE_OPTS);
  res.clearCookie("refresh_token", COOKIE_OPTS);
}
