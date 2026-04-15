import { supabase } from "../../lib/supabase.js";
import { AppError } from "../utils/AppError.js";

/**
 * Middleware to authenticate users using Supabase Auth.
 * Falls back to a default user ID if requested by the developer.
 */
export const authenticate = async (req, res, next) => {
    try {
        console.log(`\n🔐 Auth Middleware: ${req.method} ${req.url}`);
        const authHeader = req.headers.authorization;
        const defaultUserId = "a1467c37-23de-4fb4-bf9a-d4f24e672ac3";

        // 1. Check for token in headers
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            
            const { data: { user }, error } = await supabase.auth.getUser(token);

            if (error || !user) {
                // If token is present but invalid, we might still want to fallback for dev
                console.warn("⚠️ Authentication failed, using default user ID as fallback.");
                req.user = { id: defaultUserId };
            } else {
                req.user = user;
            }
        } else {
            // 2. Fallback to default user ID for now as requested
            req.user = { id: defaultUserId };
        }

        next();
    } catch (err) {
        console.error("❌ Auth Middleware Error:", err);
        next(new AppError("Authentication failed", 401));
    }
};
