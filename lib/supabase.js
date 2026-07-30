import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn("⚠️ Supabase URL or Key is missing in .env file.");
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: 'pkce'
    }
});

export const supabaseAdmin = createClient(
    supabaseUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey,
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
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                path: "/",
                maxAge: 10 * 60 * 1000 // 10 minutes is plenty for OAuth flow
            });
        },
        removeItem(key) {
            if (!res) return;
            res.clearCookie(key, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
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
            flowType: 'pkce',
            storage
        }
    });
}
