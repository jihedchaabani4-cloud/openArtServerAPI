import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { envConfig } from "../config/env.js";

const supabaseUrl = envConfig.supabaseUrl;
const supabaseKey = envConfig.supabaseKey;

if (!supabaseUrl || !supabaseKey) {
    if (!envConfig.isTest) {
        throw new Error("Fatal: Supabase URL or Key is missing in environment variables.");
    }
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: "pkce"
    }
});

export const supabaseAdmin = createClient(
    supabaseUrl,
    envConfig.supabaseServiceRoleKey || supabaseKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }
);

/**
 * Creates a request-bound Supabase client that stores OAuth PKCE verifiers 
 * in httpOnly cookies, solving the stateless server auth problem.
 */
export function createRequestBoundClient(req, res) {
    const storage = {
        getItem(key) {
            return req?.cookies?.[key] || null;
        },
        setItem(key, value) {
            if (!res) return;
            res.cookie(key, value, {
                httpOnly: true,
                secure: envConfig.isProduction,
                sameSite: "lax",
                path: "/",
                maxAge: 10 * 60 * 1000 // 10 minutes is plenty for OAuth flow
            });
        },
        removeItem(key) {
            if (!res) return;
            res.clearCookie(key, {
                httpOnly: true,
                secure: envConfig.isProduction,
                sameSite: "lax",
                path: "/"
            });
        }
    };

    return createClient(supabaseUrl, supabaseKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: true,
            detectSessionInUrl: false,
            flowType: "pkce",
            storage
        }
    });
}
