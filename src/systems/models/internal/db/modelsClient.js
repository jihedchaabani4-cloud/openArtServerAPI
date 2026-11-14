/**
 * System 2: Models Management — Supabase client access (for pricing rules table)
 * Strictly isolated inside internal/db/ per Rule 6 & Rule 12.
 */
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

export function getModelsSupabaseAdminClient() {
    return supabaseAdmin || supabase;
}

export { supabase, supabaseAdmin };
export default getModelsSupabaseAdminClient;
