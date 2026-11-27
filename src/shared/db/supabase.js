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
