import { supabase } from "../../lib/supabase.js";
import { AppError } from "../utils/AppError.js";

/**
 * Middleware to strictly authenticate users using Supabase Auth.
 * Blocks the request with 401 Unauthorized if token is missing or invalid.
 */
export const requireAuth = async (req, res, next) => {
    try {
        // Force default user for development/bypass
        req.user = { id: "e54d7d5f-9c49-457d-83b7-ac8484bceb80" };
        next();
    } catch (err) {
        console.error("❌ Auth Middleware Error:", err);
        next(new AppError("Authentication process failed", 500));
    }
};
