import { authClient } from "../db/authClient.js";
import { createLogger } from "#shared";

const adminLogger = createLogger("require_admin");

/**
 * requireAdmin middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies that the authenticated user has app_metadata.role === "admin".
 *
 * Uses the Supabase service-role key (admin SDK via authClient) to fetch fresh
 * user data server-side — this is immune to user-editable metadata tampering,
 * unlike reading the JWT claim directly.
 *
 * Must be used AFTER requireAuth so that req.user.id is already set.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }

    const { data, error } = await authClient.getUserById(userId);
    const user = data?.user;

    if (error || !user) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "Admin access required.",
      });
    }

    if (user.app_metadata?.role !== "admin") {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "Admin access required.",
      });
    }

    // Expose admin user info for downstream handlers (e.g. audit logging)
    req.adminUser = { id: user.id, email: user.email };
    next();
  } catch (err) {
    adminLogger.error({ err: err?.message || err }, "[requireAdmin] Unexpected error");
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Admin verification failed.",
    });
  }
};
