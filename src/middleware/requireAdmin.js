import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

/**
 * requireAdmin middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies that the authenticated user has app_metadata.role === "admin".
 *
 * Uses the Supabase service-role key (admin SDK) to fetch fresh user data
 * server-side — this is immune to user-editable metadata tampering, unlike
 * reading the JWT claim directly.
 *
 * Must be used AFTER requireAuth so that req.user.id is already set.
 *
 * Usage:
 *   router.post('/credit', requireAuth, requireAdmin, handler)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export const requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }

    const { data: { user }, error } = await supabaseAdmin.auth.admin.getUserById(userId);

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
    console.error("[requireAdmin] Unexpected error:", err?.message || err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Admin verification failed.",
    });
  }
};
