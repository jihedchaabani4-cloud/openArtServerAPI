/**
 * Supabase client access strictly isolated inside internal/db/ per Rule 6 & Rule 12.
 */
import { supabase, supabaseAdmin } from "#lib/supabase.js";

export function getMediaSupabaseClient() {
    return supabase;
}

export function getMediaSupabaseAdminClient() {
    return supabaseAdmin || supabase;
}

export { supabase, supabaseAdmin };
export default getMediaSupabaseClient;
