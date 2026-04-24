import { supabase } from "../../lib/supabase.js";
import { AppError } from "../utils/AppError.js";

/**
 * Middleware to strictly authenticate users using Supabase Auth.
 * Blocks the request with 401 Unauthorized if token is missing or invalid.
 */
export const requireAuth = async (req, res, next) => {
    try {
        let token = req.cookies?.access_token;
        const refreshToken = req.cookies?.refresh_token;

        if (!token && !refreshToken) {
            return next(new AppError("Authentication required. Please log in.", 401));
        }

        let user = null;

        // Try using the access token first
        if (token) {
            const { data, error } = await supabase.auth.getUser(token);
            if (!error && data?.user) {
                user = data.user;
            }
        }

        // If access token is missing or expired, try to refresh
        if (!user && refreshToken) {
            const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({ 
                refresh_token: refreshToken 
            });

            if (refreshError || !refreshData?.session) {
                // Clear invalid cookies
                res.clearCookie("access_token");
                res.clearCookie("refresh_token");
                return next(new AppError("Session expired. Please log in again.", 401));
            }

            user = refreshData.user;
            
            // Set new cookies in the response
            res.cookie("access_token", refreshData.session.access_token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "Lax",
                maxAge: 3600 * 1000, // 1 hour
            });

            res.cookie("refresh_token", refreshData.session.refresh_token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "Lax",
                maxAge: 30 * 24 * 3600 * 1000, // 30 days
            });
        }

        if (!user) {
            return next(new AppError("Invalid or expired authentication token.", 401));
        }

        // Pass user ID in the request
        req.user = { id: user.id };
        next();
    } catch (err) {
        console.error("❌ Auth Middleware Error:", err);
        next(new AppError("Authentication process failed", 500));
    }
};
